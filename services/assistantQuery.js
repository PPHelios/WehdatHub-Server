// services/assistantQuery.js — Orchestrates POST /api/v1/assistant/query: deterministic zero-credit CRM/Resale
// execution first, falling back to Gemini Primary/Q&A only when needed, strictly scoped by agency_id, role & workspace.
"use strict";

const Router = require("../domain/assistantRouter");
const Authz = require("../lib/authz");
const Segments = require("../domain/segments");
const Vis = require("../lib/visibility");
const Dash = require("./dashboards");
const Deals = require("./deals");
const Leads = require("./leads");
const LeadRules = require("./leadRules");
const Commissions = require("./commissions");
const LeadSources = require("./leadSources");
const WinLoss = require("./winLoss");
const Intake = require("./leadIntake");
const Leases = require("./leases");
const Search = require("./search");
const Assistant = require("./assistant");
const ProjectSearch = require("./projectSearch");
const AnswerLine = require("../domain/projectAnswerLine");
const Storage = require("../lib/supabase");
const SearchLink = require("../domain/searchLink");
const ViewGuard = require("../lib/viewGuard");
const { formatInterpretation } = require("../lib/search");

const Suggest = require("../domain/assistantSuggestions");
const Charts = require("../domain/assistantCharts");
const Q = require("../domain/searchQuery");
const isManagerOrOwner = (b) => Authz.isManager(b);
const isTeamLead = (b) => Authz.isTeamLead(b);
const langOf = (b) => (b?.preferred_lang === "en" ? "en" : "ar");

function allowsFeature(actor, feature) {
  return !actor?.workspace || Segments.allows(actor.workspace, feature);
}

function hasMultiBrokerScope(actor) {
  return allowsFeature(actor, "seeAll");
}

function unitDto(r, brokerId, photoOf, thumbOf) {
  const { unitView } = require("../api/units");
  return {
    ...unitView(r),
    mine: r.broker_id === brokerId,
    photo: photoOf.get(r.id) || null,
    thumb: thumbOf.get(r.id) || null
  };
}

async function recommendedForAgency(pool, actor, excludeIds = new Set()) {
  const { brokers } = await LeadRules.routingList(pool, actor.agency_id);
  const nowMs = Date.now();
  const teamScoped = isTeamLead(actor) && !isManagerOrOwner(actor)
    ? brokers.filter((b) => b.id === actor.id || b.team_lead_id === actor.id)
    : brokers;
  const available = teamScoped.filter((b) => !b.away_until || new Date(b.away_until).getTime() <= nowMs);
  const fresh = excludeIds.size ? available.filter((b) => !excludeIds.has(b.id)) : available;
  return (fresh.length ? fresh : available)
    .sort((a, b) => Number(a.open_leads || 0) - Number(b.open_leads || 0) || a.name.localeCompare(b.name))
    .slice(0, 5)
    .map((b) => ({ id: b.id, name: b.name, open: Number(b.open_leads || 0) }));
}

async function runCrmLeads(pool, actor, queueHint, en) {
  const queue = queueHint || "waiting-over-1h";
  const { rows, total } = await Leads.listLeads(pool, actor, { queue, limit: 5, offset: 0 });
  const canAssign = (isManagerOrOwner(actor) || isTeamLead(actor)) && allowsFeature(actor, "assignLeads");
  const canNudge = (isManagerOrOwner(actor) || isTeamLead(actor)) && hasMultiBrokerScope(actor);
  const stuckHolders = new Set(rows.map((r) => r.assigned_broker_id).filter(Boolean));
  const recommendedBrokers = canAssign ? await recommendedForAgency(pool, actor, stuckHolders) : [];
  const labelMap = {
    "waiting-over-1h": en ? "Leads waiting > 1h" : "عملاء مستنين أكتر من ساعة",
    unassigned: en ? "Unassigned leads" : "عملاء من غير وسيط",
    overdue: en ? "Overdue follow-ups" : "متابعات متأخرة",
    uncontacted: en ? "Uncontacted leads" : "عملاء محدش كلمهم"
  };
  return {
    intent: "crm_leads",
    headline: `${labelMap[queue] || labelMap["waiting-over-1h"]} · ${total}`,
    windowLabel: en ? "Live queue" : "القائمة الحالية",
    cards: [
      {
        kind: "stuck_leads",
        queue,
        total,
        recommendedBrokers,
        canAssign,
        canNudge,
        items: rows.map((l) => ({
          ref: `L-${String(l.ref).padStart(4, "0")}`,
          name: l.name || null,
          stage: l.stage,
          version: Number(l.version || 1),
          assignee: l.assignee_name || null,
          assigneeId: l.assigned_broker_id || null,
          createdAt: l.created_at ? new Date(l.created_at).toISOString() : null
        }))
      }
    ],
    actions: canAssign ? [{ kind: "open_queue", label: en ? "Open lead queue" : "افتح القائمة", queue }] : [],
    links: [{ label: en ? "Open Leads" : "صفحة العملاء", screen: "LeadsList", params: {} }],
    aiUsed: false
  };
}

const DAY_MS = 24 * 3600 * 1000;

function resolveRange(windowInfo, now, defaultDays = 30) {
  const start = windowInfo?.from || windowInfo?.since;
  const end = windowInfo?.to || windowInfo?.until;
  if (start && end) {
    const s = new Date(start);
    const e = new Date(end);
    return {
      since: s,
      until: e,
      from: s,
      to: e,
      labelEn: windowInfo.labelEn,
      labelAr: windowInfo.labelAr,
      daysSpan: Math.max(1, Math.round((e.getTime() - s.getTime()) / DAY_MS))
    };
  }
  const interval = Router.resolveInterval({ days: defaultDays, now });
  return {
    since: interval.from,
    until: interval.to,
    from: interval.from,
    to: interval.to,
    labelEn: `Last ${defaultDays} days`,
    labelAr: `آخر ${defaultDays} يوم`,
    daysSpan: defaultDays
  };
}

function buildUnitAppliedFilters(filters, marketLock, en) {
  const out = [];
  const f = filters || {};
  const mkt = f.market || marketLock;
  if (mkt === "resale") out.push(en ? "Market: Resale" : "السوق: ريسيل");
  else if (mkt === "primary") out.push(en ? "Market: Primary" : "السوق: برايمري");
  if (f.listing_type === "sale") out.push(en ? "Type: Sale" : "الغرض: بيع");
  else if (f.listing_type === "rent") out.push(en ? "Type: Rent" : "الغرض: إيجار");
  if (Array.isArray(f.property_types) && f.property_types.length) out.push(f.property_types.join("/"));
  if (Array.isArray(f.places) && f.places.length) out.push(f.places.map((p) => p.key).join(", "));
  else if (Array.isArray(f.place_terms) && f.place_terms.length) out.push(f.place_terms.join(", "));
  if (f.price_max != null) out.push(en ? `Price <= ${f.price_max}` : `السعر <= ${f.price_max}`);
  if (f.price_min != null) out.push(en ? `Price >= ${f.price_min}` : `السعر >= ${f.price_min}`);
  if (f.bedrooms_min != null) out.push(en ? `${f.bedrooms_min}+ beds` : `${f.bedrooms_min}+ غرف`);
  if (f.sort) out.push(en ? `Sort: ${f.sort}` : `الترتيب: ${f.sort}`);
  return out;
}

/** The understood filters as data (the app's "why it matches" chips); null = not asked. */
function structuredUnitFilters(filters) {
  const f = filters || {};
  const n = (v) => (v == null ? null : v);
  return {
    bedrooms: { min: n(f.bedrooms_min), max: n(f.bedrooms_max) },
    propertyTypes: Array.isArray(f.property_types) ? f.property_types : [],
    finishing: Array.isArray(f.finishing) ? f.finishing : [],
    places: Array.isArray(f.places) && f.places.length ? f.places.map((p) => p.key) : Array.isArray(f.place_terms) ? f.place_terms : [],
    price: { min: n(f.price_min), max: n(f.price_max) },
    delivery: { ready: typeof f.delivery_ready === "boolean" ? f.delivery_ready : null, byYear: n(f.delivery_by_year) }
  };
}

function flexBrokerRegex(rawBroker) {
  const clean = String(rawBroker || "").replace(/[\u0640\u064b-\u065f]/g, "").trim();
  if (!clean) return null;
  const body = [...clean].map((ch) => {
    if (/[اأإآ]/.test(ch)) return "[اأإآ]";
    if (/[هة]/.test(ch)) return "[هة]";
    if (/[يى]/.test(ch)) return "[يى]";
    return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("");
  return new RegExp(body, "i");
}

function buildDisambiguateResponse({ queryText, rawBroker, matches, en }) {
  const re = flexBrokerRegex(rawBroker);
  const replaceBroker = (fullName) => (re && re.test(queryText) ? queryText.replace(re, fullName) : `${queryText} ${fullName}`.trim());
  return {
    intent: "disambiguate",
    headline: en ? `Which "${rawBroker}" did you mean?` : `تقصد أنهي "${rawBroker}"؟`,
    windowLabel: en ? "Choose team member" : "اختر البروكر",
    cards: [
      {
        kind: "disambiguate",
        prompt: rawBroker,
        options: matches.slice(0, 6).map((b) => ({
          id: b.id,
          label: b.name,
          query: replaceBroker(b.name)
        }))
      }
    ],
    actions: [],
    links: [],
    aiUsed: false
  };
}

/** The equal-length window right before `range`, for metric deltas. */
function prevRange(range) {
  const span = range.until.getTime() - range.since.getTime();
  return { since: new Date(range.since.getTime() - span), until: new Date(range.since.getTime()) };
}
/** Adds `delta` (now - before) and `deltaGood` (false when it moved the wrong way; `lowerBetter` flips it). */
function withDelta(item, now, before, lowerBetter = false) {
  if (typeof now !== "number" || typeof before !== "number") return item;
  const delta = now - before;
  return { ...item, delta, deltaGood: lowerBetter ? delta <= 0 : delta >= 0 };
}

/** Every bar_breakdown gets a text summary (accessibility + share). */
function withSummaries(r, en) {
  if (!r?.cards) return r;
  return { ...r, cards: r.cards.map((c) => (c.kind === "bar_breakdown" && !c.summary ? { ...c, summary: Charts.barSummary(c.title, c.rows, en) } : c)) };
}

/** "prices in <area>": histogram of the agency's active EGP sale prices there (units the actor may see). */
async function runPrices(pool, actor, routeInfo, en, budget = null) {
  const place = String(routeInfo.areaQuery || "").trim();
  const { rows } = await pool.query(
    `SELECT price_value FROM listings
      WHERE ${Vis.units("listings")} AND agency_id = $1 AND status = 'active' AND listing_type = 'sale' AND price_value > 0
        AND coalesce(details->>'currency', 'EGP') = 'EGP'
        AND (compound ILIKE $2 OR district ILIKE $2 OR city ILIKE $2) LIMIT 2000`,
    [actor.agency_id, `%${place.replace(/[%_\\]/g, "")}%`]
  );
  const card = Charts.priceRangeCard({ title: en ? `Prices in ${place}` : `الأسعار في ${place}`, place, prices: rows.map((r) => r.price_value), budget, en, link: { screen: "Prices", params: {} } });
  return {
    intent: "crm_prices",
    headline: card ? card.summary : (en ? `Not enough units in ${place} to draw a price range (need 3+).` : `مفيش وحدات كفاية في ${place} نرسم منها نطاق الأسعار (محتاج ٣ على الأقل).`),
    windowLabel: en ? "Active resale sale units" : "وحدات البيع المتاحة",
    cards: card ? [card] : [],
    actions: [],
    links: [{ label: en ? "Price insights" : "أسعار المتر", screen: "Prices", params: {} }],
    aiUsed: false
  };
}

/** "compare": the units of the last search (previousContext.unitCodes), side by side. Same visibility as unit search. */
async function runCompare(pool, actor, previousContext, routeInfo, en) {
  const codes = (Array.isArray(previousContext?.unitCodes) ? previousContext.unitCodes : []).map(String).slice(0, routeInfo.count || 3);
  const { rows } = codes.length >= 2
    ? await pool.query(`SELECT l.* FROM listings l WHERE ${Vis.units("l")} AND l.agency_id = $1 AND l.code = ANY($2::text[])`, [actor.agency_id, codes])
    : { rows: [] };
  const units = codes.map((c) => rows.find((r) => r.code === c)).filter(Boolean);
  const card = Charts.compareCard({ units, en, link: { screen: "UnitsList", params: {} } });
  if (!card) {
    return {
      intent: "clarify",
      headline: en ? "Search for units first, then ask me to compare them." : "دور على وحدات الأول وبعدين اطلب مني أقارنهم.",
      windowLabel: en ? "Need units to compare" : "محتاج وحدات للمقارنة",
      cards: [],
      actions: [],
      links: [{ label: en ? "Units list" : "قائمة الوحدات", screen: "UnitsList", params: {} }],
      nextContext: null,
      aiUsed: false
    };
  }
  return {
    intent: "compare",
    headline: card.summary,
    windowLabel: en ? "Unit comparison" : "مقارنة الوحدات",
    cards: [card],
    actions: [],
    links: [{ label: en ? "Open all units" : "كل الوحدات", screen: "UnitsList", params: {} }],
    nextContext: { job: "find_units", unitCodes: units.map((u) => u.code) },
    aiUsed: false
  };
}

async function runDisciplineOrBroker(pool, actor, routeInfo, now, en, cleanText = "") {
  if (!isManagerOrOwner(actor) && !isTeamLead(actor)) {
    return {
      intent: "clarify",
      notForRole: true,
      headline: en ? "Team performance is limited to managers and team leads." : "تقارير أداء الفريق متاحة للمديرين وقادة الفرق بس.",
      windowLabel: en ? "Access scope" : "الصلاحيات",
      cards: [],
      actions: [],
      links: [{ label: en ? "My leads" : "عملائي", screen: "LeadsList", params: {} }],
      aiUsed: false
    };
  }
  const { route, brokerQuery, teamQuery, windowInfo } = routeInfo;
  if (!hasMultiBrokerScope(actor)) {
    const q = Router.normalize(brokerQuery || "");
    const selfMatch = route === "crm_broker" && q && Router.normalize(actor.name || "").includes(q);
    if (!selfMatch) {
      return {
        intent: "clarify",
        headline: en ? "Team performance reports require adding teammates to your workspace." : "تقارير أداء الفريق متاحة لما تضيف أعضاء للفريق.",
        windowLabel: en ? "Personal workspace" : "مساحة عمل فردية",
        cards: [],
        actions: [],
        links: [
          { label: en ? "My Stats" : "إحصائياتي", screen: "Dashboard", params: {} },
          { label: en ? "Plan" : "الباقة", screen: "Plan", params: {} }
        ],
        aiUsed: false
      };
    }
  }
  const range = resolveRange(windowInfo, now, 30);
  let targetTeamLeadId = isTeamLead(actor) ? actor.id : null;
  let teamLabel = null;
  if (route === "crm_team" && isTeamLead(actor) && !isManagerOrOwner(actor) && teamQuery) {
    const qTeam = Router.normalize(teamQuery);
    if (!Router.normalize(actor.name || "").includes(qTeam)) {
      return {
        intent: "clarify",
        headline: en ? "Team leads can view their own team's performance only." : "قائد الفريق يقدر يتابع أداء فريقه هو بس.",
        windowLabel: en ? range.labelEn : range.labelAr,
        cards: [],
        actions: [],
        links: [{ label: en ? "Team" : "الفريق", screen: "Team", params: {} }],
        aiUsed: false
      };
    }
  }
  if (route === "crm_team" && isManagerOrOwner(actor) && !isTeamLead(actor) && teamQuery) {
    const qTeam = Router.normalize(teamQuery);
    const { rows: tls } = await pool.query("SELECT id, name FROM brokers WHERE agency_id = $1 AND lower(role) = 'team_lead' AND is_active", [actor.agency_id]);
    const hit = tls.find((t) => Router.normalize(t.name).includes(qTeam)) || Router.findMatchingBrokers(tls, teamQuery)[0];
    if (!hit) {
      return {
        intent: "clarify",
        headline: en ? `Could not find a team lead matching "${teamQuery}".` : `ملقيناش قائد فريق بالاسم "${teamQuery}".`,
        windowLabel: en ? range.labelEn : range.labelAr,
        cards: [],
        actions: [],
        links: [{ label: en ? "Team" : "الفريق", screen: "Team", params: {} }],
        aiUsed: false
      };
    }
    targetTeamLeadId = hit.id;
    teamLabel = hit.name;
  }

  let scopedBrokerIds = null;
  if (targetTeamLeadId) {
    const { rows: mem } = await pool.query(
      "SELECT id FROM brokers WHERE agency_id = $1 AND (id = $2 OR team_lead_id = $2)",
      [actor.agency_id, targetTeamLeadId]
    );
    scopedBrokerIds = new Set(mem.map((r) => r.id));
  }

  // When a specific calendar window is asked (today / yesterday / this week / this month), compute exact Cairo range.
  const allRows = await Dash.brokerActivity(pool, actor.agency_id, { since: range.since, until: range.until });
  const board = allRows.filter((b) => b.active !== false && (!scopedBrokerIds || scopedBrokerIds.has(b.id)));
  const Discipline = require("../domain/discipline");
  const summary = Discipline.summarizeBoard(board);

  if (route === "crm_team") {
    const agg = board.reduce(
      (s, b) => ({
        calls: s.calls + Number(b.calls || 0),
        viewings: s.viewings + Number(b.viewings || 0),
        updates: s.updates + Number(b.updates || 0),
        deals: s.deals + Number(b.deals || 0),
        leads: s.leads + Number(b.leads || 0)
      }),
      { calls: 0, viewings: 0, updates: 0, deals: 0, leads: 0 }
    );
    const titlePrefix = teamLabel ? (en ? `${teamLabel}'s team` : `فريق ${teamLabel}`) : (en ? "Your team" : "فريقك");
    return {
      intent: "crm_team",
      headline: `${titlePrefix} · ${agg.calls} ${en ? "calls" : "مكالمة"} · ${agg.viewings} ${en ? "viewings" : "معاينة"} · ${agg.deals} ${en ? "deals" : "صفقة"}`,
      windowLabel: en ? range.labelEn : range.labelAr,
      cards: [
        {
          kind: "metric_row",
          items: [
            { label: en ? "Calls" : "مكالمات", value: agg.calls, tone: "neutral" },
            { label: en ? "Viewings" : "معاينات", value: agg.viewings, tone: "neutral" },
            { label: en ? "App updates" : "تحديثات", value: agg.updates, tone: "ok" },
            { label: en ? "Deals" : "صفقات", value: agg.deals, tone: agg.deals ? "ok" : "neutral" }
          ]
        },
        ...(board.some((b) => Number(b.deals) > 0)
          ? [{
              kind: "bar_breakdown",
              title: en ? "Deals by broker" : "الصفقات لكل بروكر",
              rows: [...board].sort((a, b) => Number(b.deals || 0) - Number(a.deals || 0)).slice(0, 6).map((b) => ({ key: String(b.id), label: b.name, count: Number(b.deals || 0), ...(b.avatarUrl ? { avatarUrl: b.avatarUrl } : {}) })),
              link: { screen: "Team", params: {} }
            }]
          : []),
        { kind: "broker_discipline", summary, rows: board.slice(0, 8) }
      ],
      actions: [],
      links: [{ label: en ? "Team" : "الفريق", screen: "Team", params: {} }],
      aiUsed: false
    };
  }

  if (route === "crm_broker") {
    const matches = Router.findMatchingBrokers(board, brokerQuery);
    if (matches.length > 1) {
      return buildDisambiguateResponse({ queryText: cleanText || brokerQuery, rawBroker: brokerQuery, matches, en });
    }
    const match = matches[0] || null;
    if (!match) {
      return {
        intent: "clarify",
        headline: en ? `Could not find a team member matching "${brokerQuery}".` : `ملقيناش حد في الفريق بالاسم "${brokerQuery}".`,
        windowLabel: en ? range.labelEn : range.labelAr,
        cards: [],
        actions: [],
        links: [{ label: en ? "Team" : "الفريق", screen: "Team", params: {} }],
        aiUsed: false
      };
    }
    return {
      intent: "crm_broker",
      headline: en ? `${match.name} · ${en ? range.labelEn : range.labelAr}` : `تقييم ${match.name} · ${range.labelAr}`,
      windowLabel: en ? range.labelEn : range.labelAr,
      cards: [
        { kind: "broker_scorecard", broker: match },
        {
          kind: "metric_row",
          items: [
            { label: en ? "Calls" : "مكالمات", value: Number(match.calls || 0), tone: "neutral" },
            { label: en ? "Viewings" : "معاينات", value: Number(match.viewings || 0), tone: "neutral" },
            { label: en ? "Updates" : "تحديثات", value: Number(match.updates || 0), tone: "ok" },
            { label: en ? "Deals" : "صفقات", value: Number(match.deals || 0), tone: match.deals ? "ok" : "neutral" }
          ]
        }
      ],
      actions: [],
      links: [
        { label: en ? "Open team" : "الفريق", screen: "Team", params: {} },
        { label: en ? "Dashboard" : "لوحة الأداء", screen: isManagerOrOwner(actor) ? "Dashboard" : "LeadsList", params: {} }
      ],
      nextContext: { job: "broker_activity", window: windowInfo || null },
      aiUsed: false
    };
  }

  const order = { silent: 0, lagging: 1, consistent: 2 };
  const sorted = [...board].sort((a, b) => (order[a.discipline] ?? 2) - (order[b.discipline] ?? 2) || Number(b.staleOpen || 0) - Number(a.staleOpen || 0));
  return {
    intent: "crm_discipline",
    headline: summary.silent
      ? (en ? `${summary.silent} silent broker(s) · ${summary.lagging} lagging` : `${summary.silent} بروكر بدون تحديثات · ${summary.lagging} متأخر`)
      : (en ? `App updates: ${summary.consistent} consistent · ${summary.lagging} lagging` : `التزام التحديث: ${summary.consistent} منتظم · ${summary.lagging} متأخر`),
    windowLabel: en ? `${range.labelEn} · 48h silence check` : `${range.labelAr} · فحص ٤٨ ساعة`,
    cards: [{ kind: "broker_discipline", summary, rows: sorted.slice(0, 8) }],
    actions: [],
    links: isManagerOrOwner(actor) ? [{ label: en ? "Open Dashboard" : "افتح لوحة الأداء", screen: "Dashboard", params: {} }] : [],
    aiUsed: false
  };
}

async function runExecutiveReport(pool, actor, routeInfo, now, en, cleanText = "") {
  const { route, windowInfo, sourceFilter } = routeInfo;
  if (route === "crm_deals") {
    const range = resolveRange(windowInfo, now, 30);
    const personalOnly = !isManagerOrOwner(actor) || !hasMultiBrokerScope(actor);
    let brokerId = null;
    let brokerName = null;
    let brokerRole = routeInfo.brokerRole === "participant" ? "participant" : "closer";
    if (routeInfo.brokerQuery) {
      const nq = Router.normalize(routeInfo.brokerQuery);
      if (personalOnly) {
        if (!Router.normalize(actor.name || "").includes(nq)) {
          return {
            intent: "clarify",
            headline: en ? "Deals are personal-only for your role." : "الصفقات شخصية بس لصلاحياتك الحالية.",
            windowLabel: en ? "Access scope" : "الصلاحيات",
            cards: [],
            actions: [],
            links: [{ label: en ? "My Deals" : "صفقاتي", screen: "Deals", params: {} }],
            aiUsed: false
          };
        }
        brokerId = actor.id;
        brokerName = actor.name || null;
      } else {
        const { rows: brokers } = await pool.query("SELECT id, name FROM brokers WHERE agency_id = $1 ORDER BY is_active DESC, name", [actor.agency_id]);
        const matches = Router.findMatchingBrokers(brokers, routeInfo.brokerQuery);
        if (matches.length > 1) {
          return buildDisambiguateResponse({ queryText: cleanText || routeInfo.brokerQuery, rawBroker: routeInfo.brokerQuery, matches, en });
        }
        const match = matches[0] || null;
        if (!match) {
          return {
            intent: "clarify",
            headline: en ? `Could not find a team member matching "${routeInfo.brokerQuery}".` : `ملقيناش حد بالاسم "${routeInfo.brokerQuery}".`,
            windowLabel: en ? range.labelEn : range.labelAr,
            cards: [],
            actions: [],
            links: [{ label: en ? "Open Deals" : "افتح الصفقات", screen: "Deals", params: {} }],
            aiUsed: false
          };
        }
        brokerId = match.id;
        brokerName = match.name;
      }
    } else if (personalOnly) {
      brokerId = actor.id;
      brokerName = actor.name || null;
      brokerRole = "participant";
    }

    let areaKey = null;
    let areaLabel = routeInfo.areaQuery || null;
    if (routeInfo.areaQuery) {
      const aq = Router.normalize(routeInfo.areaQuery);
      const { rows: arRows } = await pool.query(
        "SELECT name_key, name_en FROM areas WHERE lower(name_key) = $1 OR lower(name_en) LIKE $2 LIMIT 1",
        [aq, `%${aq}%`]
      );
      if (arRows[0]) {
        areaKey = arRows[0].name_key;
        areaLabel = arRows[0].name_en || areaLabel;
      } else {
        const { rows: synRows } = await pool.query(
          "SELECT key FROM compound_synonyms WHERE kind = 'area' AND synonym_norm LIKE $1 LIMIT 1",
          [`%${aq}%`]
        );
        areaKey = synRows[0]?.key || aq;
      }
    }

    const marketFilter = routeInfo.market || null;
    const summary = await Deals.dealsSummary(pool, actor, {
      from: range.since,
      to: range.until,
      brokerId,
      brokerRole,
      market: marketFilter,
      area: areaKey
    });

    const prevDeals = await Deals.dealsSummary(pool, actor, {
      from: prevRange(range).since,
      to: prevRange(range).until,
      brokerId,
      brokerRole,
      market: marketFilter,
      area: areaKey
    });
    const appliedFilters = [
      en ? `Window: ${range.labelEn}` : `الفترة: ${range.labelAr}`,
      ...(marketFilter ? [en ? `Market: ${marketFilter}` : `السوق: ${marketFilter === "resale" ? "ريسيل" : "برايمري"}`] : []),
      ...(areaLabel ? [en ? `Area: ${areaLabel}` : `المنطقة: ${areaLabel}`] : []),
      ...(brokerName ? [brokerRole === "participant" ? (en ? `Involved in: ${brokerName}` : `بمشاركة: ${brokerName}`) : (en ? `Closed by: ${brokerName}` : `قفلها: ${brokerName}`)] : [])
    ];
    const rolePrefix = brokerName
      ? (brokerRole === "participant" ? (en ? `Involved in by ${brokerName}` : `بمشاركة ${brokerName}`) : (en ? `Closed by ${brokerName}` : `قفلها ${brokerName}`))
      : (en ? "Deals" : "الصفقات");
    const mktPrefix = marketFilter ? (en ? `${marketFilter} · ` : `${marketFilter === "resale" ? "ريسيل" : "برايمري"} · `) : "";
    const headline = en
      ? `${summary.deals} deal(s) · ${mktPrefix}${rolePrefix}`
      : `${summary.deals} صفقة · ${mktPrefix}${rolePrefix}`;
    const noteParts = [];
    if (summary.unknownMarketCount > 0) noteParts.push(en ? `${summary.unknownMarketCount} with unknown market` : `${summary.unknownMarketCount} بدون تحديد السوق`);
    if (summary.unknownAreaCount > 0) noteParts.push(en ? `${summary.unknownAreaCount} with unknown area` : `${summary.unknownAreaCount} بدون تحديد المنطقة`);

    return {
      intent: "crm_deals",
      headline,
      windowLabel: [en ? range.labelEn : range.labelAr, noteParts.join(" · ")].filter(Boolean).join(" · "),
      understood: {
        job: "deals_report",
        market: marketFilter,
        brokerRole,
        appliedFilters,
        exclusions: routeInfo.exclusions || [],
        unsupportedFilters: []
      },
      cards: [
        {
          kind: "metric_row",
          items: [
            withDelta({ label: en ? "Deals" : "الصفقات", value: summary.deals, tone: summary.deals ? "ok" : "neutral" }, summary.deals, prevDeals.deals),
            withDelta({ label: en ? "Recorded commission" : "عمولة الصفقة المسجلة", value: summary.commissionTotal, tone: "ok", unit: "EGP" }, summary.commissionTotal, prevDeals.commissionTotal),
            ...(summary.brokerShareTotal != null ? [{ label: en ? "Broker share" : "نصيب البروكر", value: summary.brokerShareTotal, tone: "neutral", unit: "EGP" }] : []),
            { label: en ? "Deal volume" : "حجم المبيعات", value: summary.volume, tone: "neutral", unit: "EGP" }
          ]
        },
        ...(summary.byMarket.length > 1
          ? [{
              kind: "bar_breakdown",
              title: en ? "By market" : "حسب السوق",
              rows: summary.byMarket.map((m) => ({ key: m.market, label: m.market, count: m.deals, valueLabel: `${m.deals} · ${Number(m.commissionTotal || 0).toLocaleString("en-US")}` }))
            }]
          : [])
      ],
      actions: [],
      links: [{
        label: en ? "Open Deals" : "افتح الصفقات",
        screen: "Deals",
        params: {
          from: range.since.toISOString(),
          to: range.until.toISOString(),
          ...(brokerId ? { brokerId, brokerRole } : {}),
          ...(marketFilter ? { market: marketFilter } : {}),
          ...(areaKey ? { area: areaKey } : {})
        }
      }],
      nextContext: {
        job: "deals_report",
        market: marketFilter,
        brokerRole,
        areaQuery: areaKey || routeInfo.areaQuery || null,
        window: windowInfo
          ? {
              key: windowInfo.key || "explicit",
              from: range.since.toISOString(),
              to: range.until.toISOString(),
              labelEn: range.labelEn,
              labelAr: range.labelAr
            }
          : null
      },
      aiUsed: false
    };
  }
  if (route === "crm_viewings") {
    const range = resolveRange(windowInfo, now, 1);
    const params = [actor.agency_id, range.since.toISOString(), range.until.toISOString()];
    let scopeSql = "";
    if (!isManagerOrOwner(actor)) {
      if (isTeamLead(actor)) {
        params.push(actor.id);
        scopeSql = ` AND (l.assigned_broker_id = $${params.length} OR l.assigned_broker_id IN (SELECT id FROM brokers WHERE agency_id = $1 AND team_lead_id = $${params.length}))`;
      } else {
        params.push(actor.id);
        scopeSql = ` AND l.assigned_broker_id = $${params.length}`;
      }
    }
    const { rows } = await pool.query(
      `SELECT l.ref, l.name, l.stage, l.version, l.assigned_broker_id, l.next_follow_up_at, b.name AS broker_name, u.code AS unit_code
         FROM leads l
         LEFT JOIN brokers b ON b.id = l.assigned_broker_id
         LEFT JOIN listings u ON u.id = l.follow_up_listing_id AND u.agency_id = l.agency_id AND ${Vis.units("u")}
        WHERE ${Vis.leads("l")} AND l.agency_id = $1
          AND l.follow_up_status = 'open' AND l.follow_up_kind = 'viewing'
          AND l.stage NOT IN ('won', 'lost')
          AND l.next_follow_up_at >= $2 AND l.next_follow_up_at < $3${scopeSql}
        ORDER BY l.next_follow_up_at`,
      params
    );
    const byBroker = new Map();
    for (const r of rows) {
      const k = r.broker_name || (en ? "Unassigned" : "بدون وسيط");
      const e = byBroker.get(k) || { id: r.assigned_broker_id || k, n: 0 };
      e.n += 1;
      byBroker.set(k, e);
    }
    const showBrokers = hasMultiBrokerScope(actor);
    const locale = en ? "en-GB" : "ar-EG";
    return {
      intent: "crm_viewings",
      headline: en ? `${rows.length} viewing(s) scheduled · ${range.labelEn}` : `${rows.length} معاينة مجدولة · ${range.labelAr}`,
      windowLabel: en ? range.labelEn : range.labelAr,
      cards: [
        {
          kind: "metric_row",
          items: [
            { label: en ? "Viewings" : "المعاينات", value: rows.length, tone: rows.length ? "ok" : "neutral" },
            ...(showBrokers ? [{ label: en ? "Brokers active" : "وسطاء عندهم معاينات", value: byBroker.size, tone: "neutral" }] : [])
          ]
        },
        ...(showBrokers && byBroker.size
          ? [{
              kind: "bar_breakdown",
              title: en ? "By broker" : "حسب البروكر",
              rows: [...byBroker.entries()].sort((a, b) => b[1].n - a[1].n).map(([label, e]) => ({ key: String(e.id), label, count: e.n }))
            }]
          : []),
        ...(rows.length
          ? [{
              kind: "stuck_leads",
              title: en ? "Scheduled viewings" : "المعاينات المجدولة",
              queue: "viewings",
              total: rows.length,
              recommendedBrokers: [],
              canAssign: false,
              canNudge: false,
              items: rows.slice(0, 10).map((l) => {
                const time = l.next_follow_up_at
                  ? new Date(l.next_follow_up_at).toLocaleTimeString(locale, { timeZone: "Africa/Cairo", hour: "numeric", minute: "2-digit" })
                  : "";
                return {
                  ref: `L-${String(l.ref).padStart(4, "0")}`,
                  name: l.name || null,
                  stage: [time, l.unit_code, l.stage].filter(Boolean).join(" · "),
                  version: Number(l.version || 1),
                  assignee: l.broker_name || null,
                  assigneeId: l.assigned_broker_id || null,
                  createdAt: l.next_follow_up_at ? new Date(l.next_follow_up_at).toISOString() : null
                };
              })
            }]
          : [])
      ],
      actions: [],
      links: [{ label: en ? "Open Calendar" : "افتح التقويم", screen: "Calendar", params: windowInfo?.key === "tomorrow" ? { tomorrow: true } : {} }],
      aiUsed: false
    };
  }

  if (route === "crm_response_time") {
    if (!isManagerOrOwner(actor) && !isTeamLead(actor)) {
      return {
        intent: "clarify",
      notForRole: true,
        headline: en ? "Response time breakdowns are available to managers and team leads." : "تقارير وقت الرد متاحة للمديرين وقادة الفرق بس.",
        windowLabel: en ? "Role scope" : "الصلاحيات",
        cards: [],
        actions: [],
        links: [{ label: en ? "My leads" : "عملائي", screen: "LeadsList", params: {} }],
        aiUsed: false
      };
    }
    const range = resolveRange(windowInfo, now, 30);
    const activityMode = /\bwho\s+(?:replied|responded)\b|مين\s+رد/i.test(Router.normalize(cleanText || ""));
    const params = [actor.agency_id, range.since.toISOString(), range.until.toISOString()];
    let teamSql = "";
    if (isTeamLead(actor) && !isManagerOrOwner(actor)) {
      params.push(actor.id);
      teamSql = ` AND (l.assigned_broker_id = $${params.length} OR l.assigned_broker_id IN (SELECT id FROM brokers WHERE agency_id = $1 AND team_lead_id = $${params.length}))`;
    }
    const windowPred = activityMode
      ? `coalesce(fc.at, l.last_contact_at) >= $2 AND coalesce(fc.at, l.last_contact_at) < $3`
      : `l.created_at >= $2 AND l.created_at < $3 AND coalesce(fc.at, l.last_contact_at) >= l.created_at`;
    const respSql = (
      `WITH base AS (
         SELECT l.assigned_broker_id AS broker_id, coalesce(b.name, '—') AS broker_name,
                GREATEST(0, extract(epoch FROM (coalesce(fc.at, l.last_contact_at) - l.created_at)) / 60) AS mins
           FROM leads l
           JOIN LATERAL (SELECT min(e.created_at) AS at FROM lead_events e
                          WHERE e.lead_id = l.id AND e.agency_id = l.agency_id AND e.kind = 'contacted' AND e.undone_at IS NULL) fc ON true
           LEFT JOIN brokers b ON b.id = l.assigned_broker_id
          WHERE ${Vis.leads("l")} AND l.agency_id = $1 AND l.assigned_broker_id IS NOT NULL
            AND ${windowPred}${teamSql}
       )
       SELECT 0 AS sort_grp, NULL::uuid AS broker_id, '__overall__' AS broker_name,
              count(*)::int AS responded,
              round(avg(mins))::int AS avg_min,
              round(percentile_cont(0.5) WITHIN GROUP (ORDER BY mins))::int AS med_min
         FROM base
       UNION ALL
       SELECT 1 AS sort_grp, broker_id, broker_name,
              count(*)::int AS responded,
              round(avg(mins))::int AS avg_min,
              round(percentile_cont(0.5) WITHIN GROUP (ORDER BY mins))::int AS med_min
         FROM base
        GROUP BY broker_id, broker_name
        ORDER BY sort_grp, avg_min ASC NULLS LAST`
    );
    const { rows: rawRows } = await pool.query(respSql, params);
    const prev = prevRange(range);
    const { rows: prevRows } = await pool.query(respSql, [params[0], prev.since.toISOString(), prev.until.toISOString(), ...params.slice(3)]);
    const prevAvg = prevRows.find((r) => r.broker_id === null && r.broker_name === "__overall__")?.avg_min;
    const overallRow = rawRows.find((r) => r.broker_id === null && r.broker_name === "__overall__");
    const rows = rawRows.filter((r) => !(r.broker_id === null && r.broker_name === "__overall__"));
    const totalResp = Number(overallRow?.responded || 0);
    const weightedAvg = overallRow?.avg_min == null ? null : Number(overallRow.avg_min);
    const overallMed = overallRow?.med_min == null ? null : Number(overallRow.med_min);
    const showPerBroker = hasMultiBrokerScope(actor);
    return {
      intent: "crm_response_time",
      headline: weightedAvg != null
        ? (en ? `Average first response: ${weightedAvg} min` : `متوسط أول رد: ${weightedAvg} دقيقة`)
        : (en ? "No contacted leads in this window" : "مفيش عملاء اترد عليهم في الفترة دي"),
      windowLabel: en ? range.labelEn : range.labelAr,
      cards: [
        {
          kind: "metric_row",
          items: [
            withDelta({ label: en ? "Average (min)" : "المتوسط (د)", value: weightedAvg ?? "—", tone: weightedAvg != null && weightedAvg <= 30 ? "ok" : "warn" }, weightedAvg, prevAvg == null ? null : Number(prevAvg), true),
            { label: en ? "Median (min)" : "الوسيط (د)", value: overallMed ?? "—", tone: "neutral" },
            { label: en ? "Contacted" : "اتكلموا", value: totalResp, tone: "neutral" }
          ]
        },
        ...(showPerBroker && rows.length
          ? [{
              kind: "bar_breakdown",
              title: en ? "Per person (average min)" : "لكل بروكر (متوسط الدقايق)",
              rows: rows.map((r) => ({ key: String(r.broker_id), label: r.broker_name, count: Number(r.avg_min || 0), valueLabel: `${r.avg_min}m avg · ${r.med_min}m med` }))
            }]
          : [])
      ],
      actions: [],
      links: isManagerOrOwner(actor) ? [{ label: showPerBroker ? (en ? "Broker rankings" : "ترتيب الوسطاء") : (en ? "My Stats" : "إحصائياتي"), screen: "Dashboard", params: {} }] : [],
      aiUsed: false
    };
  }

  if (!isManagerOrOwner(actor) && route !== "crm_stale_units") {
    return {
      intent: "clarify",
      notForRole: true,
      headline: en ? "Agency financial and marketing totals are available to managers only." : "تقارير العمولات والتسويق متاحة للمديرين وصاحب الشركة بس.",
      windowLabel: en ? "Role scope" : "الصلاحيات",
      cards: [],
      actions: [],
      links: [{ label: en ? "My leads" : "عملائي", screen: "LeadsList", params: {} }],
      aiUsed: false
    };
  }
  if (route === "crm_commissions") {
    const overdueOnly = /\boverdue\b|متاخر/i.test(cleanText || "");
    const page = await Commissions.pageCommissions(pool, actor, { ...(overdueOnly ? { overdue: true } : {}), limit: 5, now });
    const t = page?.totals || { count: 0, expected: 0, claimed: 0, paid: 0, outstanding: 0, overdue: 0, overdueAmount: 0 };
    return {
      intent: "crm_commissions",
      headline: overdueOnly
        ? (en ? `Overdue developer commissions · ${Number(t.overdue || 0)} (${Number(t.overdueAmount || t.outstanding || 0).toLocaleString("en-US")} EGP)` : `عمولات مطورين متأخرة · ${Number(t.overdue || 0)} (${Number(t.overdueAmount || t.outstanding || 0).toLocaleString("en-US")} ج.م)`)
        : (en ? `Developer commissions · ${Number(t.outstanding || 0).toLocaleString("en-US")} EGP outstanding` : `عمولات المطورين · ${Number(t.outstanding || 0).toLocaleString("en-US")} ج.م مستحق`),
      windowLabel: overdueOnly ? (en ? "Overdue developer claims" : "مطالبات متأخرة") : (en ? "All active commissions" : "كل العمولات القائمة"),
      understood: {
        job: "commissions_report",
        market: "primary",
        appliedFilters: [en ? "Kind: Developer commissions" : "النوع: عمولات مطورين", ...(overdueOnly ? [en ? "Status: Overdue" : "الحالة: متأخرة"] : [])],
        exclusions: [],
        unsupportedFilters: []
      },
      cards: [
        {
          kind: "metric_row",
          items: [
            ...(overdueOnly ? [{ label: en ? "Overdue" : "متأخرة", value: Number(t.overdue || 0), tone: t.overdue ? "critical" : "ok" }] : []),
            { label: en ? "Outstanding" : "الباقي", value: Number(t.outstanding || 0), tone: t.overdue ? "critical" : "warn", unit: "EGP" },
            { label: en ? "Paid" : "المدفوع", value: Number(t.paid || 0), tone: "ok", unit: "EGP" },
            ...(!overdueOnly ? [{ label: en ? "Overdue" : "متأخرة", value: Number(t.overdue || 0), tone: t.overdue ? "critical" : "neutral" }] : [])
          ]
        }
      ],
      actions: [],
      links: [{ label: overdueOnly ? (en ? "Overdue commissions" : "العمولات المتأخرة") : (en ? "Open Commissions" : "افتح العمولات"), screen: "Commissions", params: { kind: "developers", ...(overdueOnly ? { overdue: true } : {}) } }],
      aiUsed: false
    };
  }
  if (route === "crm_stale_units") {
    const Today = require("./today"); // same definition and scope as the Dashboard's "stale" count
    const ids = Authz.isDataEntry(actor) ? [actor.id] : await Today.scopeIds(pool, actor);
    const old = await Today.oldUnits(pool, actor, ids, now, 8);
    const total = old?.total || 0;
    const days = Today.OLD_AFTER_DAYS;
    return {
      intent: "crm_stale_units",
      headline: total
        ? (en ? `${total} unit(s) not confirmed for ${days}+ days` : `${total} وحدة محدّش أكدها من ${days} يوم أو أكتر`)
        : (en ? "No stale units. Everything is up to date." : "مفيش وحدات قديمة. كله محدّث."),
      windowLabel: en ? "Live" : "دلوقتي",
      cards: [
        { kind: "metric_row", items: [{ label: en ? "Stale units" : "وحدات قديمة", value: total, tone: total ? "warn" : "ok" }] },
        ...(old?.items.length
          ? [{
              kind: "bar_breakdown",
              title: en ? "Oldest first" : "الأقدم الأول",
              rows: old.items.map((u) => ({ key: u.code, label: `${u.code} · ${u.line}`, count: u.days, valueLabel: en ? `${u.days} d` : `${u.days} يوم` })),
              link: { screen: "UnitsList", params: {} }
            }]
          : [])
      ],
      actions: [],
      links: [{ label: en ? "Open Units" : "افتح الوحدات", screen: "UnitsList", params: {} }],
      aiUsed: false
    };
  }
  if (route === "crm_win_loss") {
    if (!allowsFeature(actor, "winLoss")) {
      return {
        intent: "clarify",
        headline: en ? "Win/loss analysis requires Team or Agency plan." : "تقرير أسباب الخسارة متاح في باقة الفريق والشركات.",
        windowLabel: en ? "Plan feature" : "الباقة",
        cards: [],
        actions: [],
        links: [{ label: en ? "View Plan" : "صفحة الباقة", screen: "Plan", params: {} }],
        aiUsed: false
      };
    }
    const range = resolveRange(windowInfo, now, 90);
    const wl = await WinLoss.report(pool, actor, windowInfo ? { since: range.since, until: range.until, now } : { days: 90, now });
    return {
      intent: "crm_win_loss",
      headline: en ? `Win rate: ${wl?.rate != null ? `${wl.rate}%` : "—"} (${wl?.won || 0} won · ${wl?.lost || 0} lost)` : `نسبة القفل: ${wl?.rate != null ? `${wl.rate}%` : "—"} (${wl?.won || 0} صفقة · ${wl?.lost || 0} ضاعت)`,
      windowLabel: en ? range.labelEn : range.labelAr,
      cards: [
        {
          kind: "metric_row",
          items: [
            { label: en ? "Won" : "اتقفلت", value: wl?.won || 0, tone: "ok" },
            { label: en ? "Lost" : "ضاعت", value: wl?.lost || 0, tone: wl?.lost ? "warn" : "neutral" },
            { label: en ? "Win rate" : "نسبة النجاح", value: wl?.rate != null ? `${wl.rate}%` : "—", tone: "neutral" }
          ]
        },
        ...[Charts.shareCard({ title: en ? "Won vs lost" : "اتقفلت وضاعت", parts: [{ key: "won", label: en ? "Won" : "اتقفلت", value: wl?.won }, { key: "lost", label: en ? "Lost" : "ضاعت", value: wl?.lost }], en, link: { screen: "WinLoss", params: {} } })].filter(Boolean),
        ...(wl?.reasons?.length
          ? [{
              kind: "bar_breakdown",
              title: en ? "Top lost reasons" : "أسباب الخسارة",
              rows: wl.reasons.slice(0, 5).map((r) => ({ key: r.key, label: r.key, count: r.n, valueLabel: `${r.n} (${r.pct}%)` }))
            }]
          : [])
      ],
      actions: [],
      links: [{ label: en ? "Win / Loss" : "تقرير الخسارة", screen: "WinLoss", params: {} }],
      aiUsed: false
    };
  }
  if (route === "crm_sources") {
    // Allow simple lead-count-by-source questions even on non-Agency plans or custom date windows; gate ad spend/CPL by sources feature.
    if (windowInfo || (sourceFilter && !allowsFeature(actor, "sources"))) {
      const range = resolveRange(windowInfo, now, 30);
      const { rows: cntRows } = await pool.query(
        `SELECT coalesce(nullif(source, ''), '—') AS source, count(*)::int AS leads
           FROM leads WHERE ${Vis.leads("leads")} AND agency_id = $1 AND created_at >= $2 AND created_at < $3
          GROUP BY 1 ORDER BY 2 DESC, 1`,
        [actor.agency_id, range.since.toISOString(), range.until.toISOString()]
      );
      const total = cntRows.reduce((s, r) => s + Number(r.leads || 0), 0);
      const match = sourceFilter ? cntRows.find((r) => r.source.toLowerCase() === sourceFilter.toLowerCase()) : null;
      const focusN = match ? Number(match.leads) : 0;
      return {
        intent: "crm_sources",
        headline: sourceFilter
          ? (en ? `${focusN} lead(s) from ${sourceFilter} · ${range.labelEn}` : `${focusN} عميل من ${sourceFilter} · ${range.labelAr}`)
          : (en ? `${total} lead(s) by source · ${range.labelEn}` : `${total} عميل حسب المصدر · ${range.labelAr}`),
        windowLabel: en ? range.labelEn : range.labelAr,
        cards: [
          {
            kind: "metric_row",
            items: sourceFilter
              ? [
                  { label: sourceFilter, value: focusN, tone: focusN ? "ok" : "neutral" },
                  { label: en ? "All sources" : "كل المصادر", value: total, tone: "neutral" }
                ]
              : [{ label: en ? "Total leads" : "إجمالي العملاء", value: total, tone: "ok" }]
          },
          ...[Charts.shareCard({ title: en ? "Source mix" : "توزيع المصادر", parts: cntRows.slice(0, 6).map((r) => ({ key: r.source, label: r.source, value: r.leads })), en })].filter(Boolean),
          ...(cntRows.length
            ? [{
                kind: "bar_breakdown",
                title: en ? "Leads by source" : "العملاء حسب المصدر",
                rows: cntRows.slice(0, 6).map((r) => ({ key: String(r.source), label: r.source, count: Number(r.leads || 0) }))
              }]
            : [])
        ],
        actions: [],
        links: allowsFeature(actor, "sources") ? [{ label: en ? "Open Sources" : "افتح المصادر", screen: "Sources", params: {} }] : [],
        aiUsed: false
      };
    }
    if (!allowsFeature(actor, "sources")) {
      return {
        intent: "clarify",
        headline: en ? "Marketing source analytics require the Agency plan." : "تحليل مصادر العملاء متاح في باقة الشركات.",
        windowLabel: en ? "Plan feature" : "الباقة",
        cards: [],
        actions: [],
        links: [{ label: en ? "View Plan" : "صفحة الباقة", screen: "Plan", params: {} }],
        aiUsed: false
      };
    }
    const [rep, channels] = await Promise.all([
      LeadSources.report(pool, actor, { now }),
      Intake.listForAgency(pool, actor.agency_id).catch(() => [])
    ]);
    const disconnected = channels.filter((c) => !c.revoked_at && c.status === "disconnected").length;
    const rows = rep?.rows || [];
    const hit = sourceFilter ? rows.find((r) => r.source.toLowerCase() === sourceFilter.toLowerCase()) : null;
    const headline = hit
      ? (en ? `${hit.leads} lead(s) from ${hit.source} this month (${hit.deals} deals)` : `${hit.leads} عميل من ${hit.source} الشهر ده (${hit.deals} صفقة)`)
      : disconnected
        ? (en ? `${disconnected} lead intake disconnected · ${rep?.totals?.leads || 0} leads this month` : `${disconnected} قناة استقبال مفصولة · ${rep?.totals?.leads || 0} عميل الشهر ده`)
        : (en ? `Lead sources · ${rep?.totals?.leads || 0} leads (${rep?.totals?.deals || 0} deals)` : `مصادر العملاء · ${rep?.totals?.leads || 0} عميل (${rep?.totals?.deals || 0} صفقة)`);
    return {
      intent: "crm_sources",
      headline,
      windowLabel: rep?.month || "",
      cards: [
        ...[Charts.shareCard({ title: en ? "Source mix" : "توزيع المصادر", parts: rows.slice(0, 6).map((r) => ({ key: String(r.source), label: r.source, value: r.leads })), en, link: { screen: "Sources", params: {} } })].filter(Boolean),
        {
          kind: "bar_breakdown",
          title: en ? "By source" : "حسب المصدر",
          rows: (hit ? [hit, ...rows.filter((r) => r !== hit)] : rows).slice(0, 5).map((r) => ({
            key: String(r.source || "unknown"),
            label: r.source,
            count: Number(r.leads || 0),
            valueLabel: `${r.leads} · ${r.deals}d`,
            commission: Number(r.commission || 0),
            spend: r.spend != null ? Number(r.spend) : null,
            won: Number(r.deals || 0)
          }))
        }
      ],
      actions: [],
      links: [{ label: en ? "Open Sources" : "افتح المصادر", screen: "Sources", params: {} }],
      aiUsed: false
    };
  }
  if (route === "crm_leases") {
    const soon = await Leases.list(pool, actor, { soon: true, now }).catch(() => []);
    return {
      intent: "crm_leases",
      headline: en ? `${soon.length} lease(s) ending within 90 days` : `${soon.length} عقد إيجار قرب يخلص (٩٠ يوم)`,
      windowLabel: en ? "Next 90 days" : "الـ٩٠ يوم الجاية",
      cards: [
        {
          kind: "metric_row",
          items: [{ label: en ? "Ending soon" : "قربت تخلص", value: soon.length, tone: soon.length ? "warn" : "ok" }]
        }
      ],
      actions: [],
      links: [{ label: en ? "Open Leases" : "افتح الإيجارات", screen: "Leases", params: {} }],
      aiUsed: false
    };
  }

  // crm_brief: executive snapshot (windowed when user asks today / week / month); personal scope for Solo.
  const personal = !hasMultiBrokerScope(actor);
  const range = resolveRange(windowInfo, now, 30);
  if (windowInfo) {
    const sumActivity = async (r) =>
      (await Dash.brokerActivity(pool, actor.agency_id, { since: r.since, until: r.until }))
        .filter((b) => b.active !== false && (!personal || b.id === actor.id))
        .reduce(
          (t, b) => ({ calls: t.calls + Number(b.calls || 0), viewings: t.viewings + Number(b.viewings || 0), updates: t.updates + Number(b.updates || 0), leads: t.leads + Number(b.leads || 0), deals: t.deals + Number(b.deals || 0) }),
          { calls: 0, viewings: 0, updates: 0, leads: 0, deals: 0 }
        );
    const prevAgg = await sumActivity(prevRange(range));
    const agg = await sumActivity(range);
    return {
      intent: "crm_brief",
      headline: personal
        ? (en ? `Your activity · ${agg.calls} calls · ${agg.viewings} viewings · ${agg.deals} deals` : `نشاطك · ${agg.calls} مكالمة · ${agg.viewings} معاينة · ${agg.deals} صفقة`)
        : (en ? `Agency activity · ${agg.calls} calls · ${agg.viewings} viewings · ${agg.deals} deals` : `نشاط الشركة · ${agg.calls} مكالمة · ${agg.viewings} معاينة · ${agg.deals} صفقة`),
      windowLabel: en ? range.labelEn : range.labelAr,
      cards: [
        {
          kind: "metric_row",
          items: [
            withDelta({ label: en ? "Calls" : "مكالمات", value: agg.calls, tone: "neutral" }, agg.calls, prevAgg.calls),
            withDelta({ label: en ? "Viewings" : "معاينات", value: agg.viewings, tone: "neutral" }, agg.viewings, prevAgg.viewings),
            withDelta({ label: en ? "Updates" : "تحديثات", value: agg.updates, tone: "ok" }, agg.updates, prevAgg.updates),
            withDelta({ label: en ? "New leads" : "عملاء جدد", value: agg.leads, tone: "neutral" }, agg.leads, prevAgg.leads),
            withDelta({ label: en ? "Deals" : "صفقات", value: agg.deals, tone: agg.deals ? "ok" : "neutral" }, agg.deals, prevAgg.deals)
          ]
        }
      ],
      actions: [],
      links: [{ label: personal ? (en ? "Open My Stats" : "افتح إحصائياتي") : (en ? "Open Dashboard" : "افتح لوحة الأداء"), screen: "Dashboard", params: {} }],
      nextContext: { job: "brief", window: windowInfo || null },
      aiUsed: false
    };
  }
  const d = await Dash.agencyDashboard(pool, actor, { days: 30, now });
  return {
    intent: "crm_brief",
    headline: personal
      ? (en ? `Your stats · ${d.deals.n} deals · ${d.overdue || 0} overdue` : `ملخصك · ${d.deals.n} صفقة · ${d.overdue || 0} متأخرة`)
      : (en ? `Agency brief · ${d.deals.n} deals · ${d.waitingOver1h || 0} waiting > 1h` : `ملخص الشركة · ${d.deals.n} صفقة · ${d.waitingOver1h || 0} مستني > ساعة`),
    windowLabel: en ? "Last 30 days" : "آخر ٣٠ يوم",
    cards: [
      {
        kind: "metric_row",
        items: [
          { label: en ? "New leads" : "عملاء جدد", value: Number(d.leads || 0), tone: "neutral" },
          ...(personal ? [] : [{ label: en ? "Waiting > 1h" : "مستني > ساعة", value: Number(d.waitingOver1h || 0), tone: d.waitingOver1h ? "critical" : "ok" }]),
          { label: en ? "Overdue" : "متأخرة", value: Number(d.overdue || 0), tone: d.overdue ? "critical" : "ok" },
          { label: en ? "Deals" : "صفقات", value: Number(d.deals?.n || 0), tone: d.deals?.n ? "ok" : "neutral" }
        ]
      },
      ...[Charts.trendCard({ title: en ? "New leads per week" : "العملاء الجدد كل أسبوع", points: (d.weekly || []).map((value, i) => ({ label: d.weeklyRanges?.[i]?.label || "", value })), en, link: { screen: "Dashboard", params: {} } })].filter(Boolean)
    ],
    actions: [],
    links: [{ label: personal ? (en ? "Open My Stats" : "افتح إحصائياتي") : (en ? "Open Dashboard" : "افتح لوحة الأداء"), screen: "Dashboard", params: {} }],
    nextContext: { job: "brief", window: windowInfo || null },
    aiUsed: false
  };
}

/**
 * Executes a single assistant query across Resale units, Primary projects, or CRM/Executive reports.
 */
async function runOpenedNoFollowup(pool, actor, en) {
  if (Authz.isDataEntry(actor)) {
    return { intent: "clarify", headline: en ? "Try unit filters instead." : "جرّب فلاتر الوحدات.", cards: [], actions: [], links: [], aiUsed: false };
  }
  const args = [actor.agency_id];
  const scope = [];
  if (isTeamLead(actor) && !isManagerOrOwner(actor)) {
    args.push(actor.id);
    scope.push(`(l.assigned_broker_id = $${args.length} OR b.team_lead_id = $${args.length})`);
  } else if (!isManagerOrOwner(actor)) {
    args.push(actor.id);
    scope.push(`l.assigned_broker_id = $${args.length}`);
  }
  const { rows } = await pool.query(
    `SELECT l.id, l.ref, l.name, l.stage, l.version, l.assigned_broker_id, b.name AS assignee_name,
            MAX(s.last_opened_at) AS last_opened_at, SUM(s.open_count)::int AS total_opens, count(*) OVER()::int AS total_n
       FROM share_links s
       JOIN listings u ON u.id = s.listing_id AND u.agency_id = s.agency_id
       JOIN leads l ON l.id = s.lead_id AND l.agency_id = s.agency_id
       LEFT JOIN brokers b ON b.id = l.assigned_broker_id AND b.agency_id = l.agency_id
      WHERE ${Vis.units("u")} AND ${Vis.leads("l")}
        AND s.agency_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND s.open_count > 0 AND l.stage NOT IN ('won', 'lost')
        AND l.follow_up_status IS DISTINCT FROM 'open'
        ${scope.length ? `AND ${scope.join(" AND ")}` : ""}
      GROUP BY l.id, l.ref, l.name, l.stage, l.version, l.assigned_broker_id, b.name
      ORDER BY MAX(s.last_opened_at) DESC NULLS LAST
      LIMIT 10`,
    args
  );
  const total = rows[0]?.total_n ?? 0;
  const canAssign = (isManagerOrOwner(actor) || isTeamLead(actor)) && allowsFeature(actor, "assignLeads");
  const canNudge = (isManagerOrOwner(actor) || isTeamLead(actor)) && hasMultiBrokerScope(actor);
  const recommendedBrokers = canAssign ? await recommendedForAgency(pool, actor, new Set()) : [];
  return {
    intent: "crm_opened_no_followup",
    headline: en ? `Offer link opened · ${total} without follow-up` : `اتفتح رابط العرض · ${total} بدون متابعة`,
    windowLabel: en ? "Offer link opened (grouped by client)" : "فتح رابط العرض (مجمّع حسب العميل)",
    cards: [
      {
        kind: "stuck_leads",
        queue: "no_next_step",
        total,
        recommendedBrokers,
        canAssign,
        canNudge,
        items: rows.map((l) => ({
          ref: `L-${String(l.ref).padStart(4, "0")}`,
          name: l.name || null,
          stage: l.stage,
          version: Number(l.version || 1),
          assignee: l.assignee_name || null,
          assigneeId: l.assigned_broker_id || null,
          createdAt: l.last_opened_at ? new Date(l.last_opened_at).toISOString() : null
        }))
      }
    ],
    actions: [],
    links: [{ label: en ? "Sent offers" : "الروابط المرسلة", screen: "Links", params: { opened: true } }],
    aiUsed: false
  };
}

async function runApproachingSla(pool, actor, now, en) {
  const rules = await LeadRules.getRules(pool, actor.agency_id);
  const args = [actor.agency_id];
  let scopeSql = "";
  if (isTeamLead(actor) && !isManagerOrOwner(actor)) {
    args.push(actor.id);
    scopeSql = ` AND (l.assigned_broker_id = $${args.length} OR b.team_lead_id = $${args.length})`;
  } else if (!isManagerOrOwner(actor)) {
    args.push(actor.id);
    scopeSql = ` AND l.assigned_broker_id = $${args.length}`;
  }
  let rows;
  if (rules.enabled) {
    args.push(now.toISOString(), new Date(now.getTime() + 30 * 60 * 1000).toISOString());
    rows = (await pool.query(
      `SELECT l.ref, l.name, l.stage, l.version, l.assigned_broker_id, b.name AS assignee_name, l.response_due_at AS ts, count(*) OVER()::int AS total_n
         FROM leads l LEFT JOIN brokers b ON b.id = l.assigned_broker_id AND b.agency_id = l.agency_id
        WHERE ${Vis.leads("l")} AND l.agency_id = $1 AND l.stage = 'new' AND l.last_contact_at IS NULL
          AND l.response_due_at IS NOT NULL AND l.response_due_at > $${args.length - 1} AND l.response_due_at <= $${args.length}${scopeSql}
        ORDER BY l.response_due_at ASC LIMIT 10`,
      args
    )).rows;
  } else {
    const min40 = new Date(now.getTime() - 40 * 60 * 1000).toISOString();
    const min60 = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    args.push(min60, min40);
    rows = (await pool.query(
      `SELECT l.ref, l.name, l.stage, l.version, l.assigned_broker_id, b.name AS assignee_name, l.created_at AS ts, count(*) OVER()::int AS total_n
         FROM leads l LEFT JOIN brokers b ON b.id = l.assigned_broker_id AND b.agency_id = l.agency_id
        WHERE ${Vis.leads("l")} AND l.agency_id = $1 AND l.assigned_broker_id IS NOT NULL AND l.stage = 'new' AND l.last_contact_at IS NULL
          AND l.created_at > $${args.length - 1} AND l.created_at <= $${args.length}${scopeSql}
        ORDER BY l.created_at ASC LIMIT 10`,
      args
    )).rows;
  }
  const total = rows[0]?.total_n ?? 0;
  const canAssign = (isManagerOrOwner(actor) || isTeamLead(actor)) && allowsFeature(actor, "assignLeads");
  const canNudge = (isManagerOrOwner(actor) || isTeamLead(actor)) && hasMultiBrokerScope(actor);
  const recommendedBrokers = canAssign ? await recommendedForAgency(pool, actor, new Set()) : [];
  return {
    intent: "crm_approaching_sla",
    headline: rules.enabled
      ? (en ? `${total} lead(s) approaching SLA deadline` : `${total} عميل قربوا على حد الـSLA`)
      : (en ? `${total} lead(s) waiting 40–59 min (agency SLA off)` : `${total} عميل مستنيين ٤٠–٥٩ دقيقة (SLA مقفول)`),
    windowLabel: rules.enabled ? (en ? "Agency SLA deadline" : "حسب قاعدة SLA") : (en ? "Waiting 40–59 min" : "انتظار ٤٠–٥٩ دقيقة"),
    cards: [
      {
        kind: "stuck_leads",
        queue: "waiting-over-1h",
        total,
        recommendedBrokers,
        canAssign,
        canNudge,
        items: rows.map((l) => ({
          ref: `L-${String(l.ref).padStart(4, "0")}`,
          name: l.name || null,
          stage: l.stage,
          version: Number(l.version || 1),
          assignee: l.assignee_name || null,
          assigneeId: l.assigned_broker_id || null,
          createdAt: l.ts ? new Date(l.ts).toISOString() : null
        }))
      }
    ],
    actions: [],
    links: [{ label: en ? "Open Leads" : "صفحة العملاء", screen: "LeadsList", params: { queue: "waiting-over-1h" } }],
    aiUsed: false
  };
}

async function runStuckBrokers(pool, actor, routeInfo, now, en) {
  if (!isManagerOrOwner(actor) && !isTeamLead(actor)) {
    return {
      intent: "clarify",
      notForRole: true,
      headline: en ? "Team next-step rankings are limited to managers and team leads." : "ترتيب الوسطاء متاح للمديرين وقادة الفرق بس.",
      windowLabel: en ? "Access scope" : "الصلاحيات",
      cards: [],
      actions: [],
      links: [{ label: en ? "My leads" : "عملائي", screen: "LeadsList", params: {} }],
      aiUsed: false
    };
  }
  if (!hasMultiBrokerScope(actor)) {
    return {
      intent: "clarify",
      headline: en ? "Team next-step rankings require adding teammates to your workspace." : "ترتيب الوسطاء متاح لما تضيف أعضاء للفريق.",
      windowLabel: en ? "Personal workspace" : "مساحة عمل فردية",
      cards: [],
      actions: [],
      links: [
        { label: en ? "My Stats" : "إحصائياتي", screen: "Dashboard", params: {} },
        { label: en ? "Plan" : "الباقة", screen: "Plan", params: {} }
      ],
      aiUsed: false
    };
  }
  const range = resolveRange(routeInfo.windowInfo, now, 30);
  const allRows = await Dash.brokerActivity(pool, actor.agency_id, { since: range.since, until: range.until });
  let scopedIds = null;
  if (isTeamLead(actor) && !isManagerOrOwner(actor)) {
    const { rows: mem } = await pool.query("SELECT id FROM brokers WHERE agency_id = $1 AND (id = $2 OR team_lead_id = $2)", [actor.agency_id, actor.id]);
    scopedIds = new Set(mem.map((r) => r.id));
  }
  const active = allRows
    .filter((b) => b.active !== false && (!scopedIds || scopedIds.has(b.id)))
    .sort((a, b) => Number(b.noNextStep || 0) - Number(a.noNextStep || 0) || Number(b.open || 0) - Number(a.open || 0) || a.name.localeCompare(b.name));
  const Discipline = require("../domain/discipline");
  const summary = Discipline.summarizeBoard(active);
  return {
    intent: "crm_stuck_brokers",
    headline: en ? `${summary.totalNoNextStep} open lead(s) without next step` : `${summary.totalNoNextStep} عميل مفتوح بدون خطوة جاية`,
    windowLabel: en ? "Ranked by no-next-step count" : "مرتب حسب بدون خطوة جاية",
    cards: [{ kind: "broker_discipline", summary, rows: active.slice(0, 8) }],
    actions: [],
    links: isManagerOrOwner(actor) ? [{ label: en ? "Open Dashboard" : "لوحة الأداء", screen: "Dashboard", params: {} }] : [],
    aiUsed: false
  };
}

async function queryInner(pool, { AI, actor, agency = null, text, mode = "auto", previousContext = null, now = new Date() }) {
  const en = langOf(actor) === "en";
  const lang = en ? "en" : "ar";
  const safeMode = Router.MODES.includes(mode) ? mode : "auto";
  const cleanText = String(text || "").trim().slice(0, 500);
  if (!cleanText) return { error: "empty" };

  const routeInfo = Router.classifyAssistantQuery({ text: cleanText, mode: safeMode, now, previousContext });
  if (Authz.isDataEntry(actor) && routeInfo.route !== "unit_search" && routeInfo.route !== "crm_stale_units") {
    return {
      intent: "clarify",
      modeUsed: safeMode,
      headline: en ? "Try searching units by code, compound, or missing photos." : "جرّب تدور بالوحدة أو الكمبوند أو الوحدات اللي من غير صور.",
      windowLabel: "",
      cards: [],
      actions: [],
      links: [{ label: en ? "Units list" : "قائمة الوحدات", screen: "UnitsList", params: {} }],
      aiUsed: false
    };
  }

  if (routeInfo.route === "clarify") {
    if (routeInfo.clarifyKind === "unknown_question") {
      return {
        intent: "clarify",
        modeUsed: safeMode,
        headline: en ? "I didn't get that one. Try one of these:" : "مفهمتش السؤال ده. جرّب واحدة من دول:",
        windowLabel: en ? "Clarification needed" : "وضّح طلبك",
        understood: { job: "clarify_question", market: null, appliedFilters: [], exclusions: [], unsupportedFilters: [] },
        cards: [],
        actions: [],
        links: [],
        aiUsed: false
      };
    }
    if (routeInfo.clarifyKind === "off_topic") {
      return {
        intent: "clarify",
        modeUsed: safeMode,
        headline: en ? "That's outside what I do. I help with units, clients and numbers — try one of these:" : "دي مش من شغلي للأسف. أنا بساعدك في الوحدات والعملاء والأرقام — جرّب واحدة من دول:",
        windowLabel: "",
        understood: { job: "off_topic", market: null, appliedFilters: [], exclusions: [], unsupportedFilters: [] },
        cards: [],
        actions: [],
        links: [],
        aiUsed: false
      };
    }
    if (routeInfo.clarifyKind === "missing_context") {
      return {
        intent: "clarify",
        modeUsed: safeMode,
        headline: en ? "Write the full search or report first — there is no active search to refine." : "اكتب البحث أو التقرير كامل الأول — مفيش بحث شغال نعدّل عليه.",
        windowLabel: en ? "Need full question" : "سياق ناقص",
        understood: { job: "clarify_context", market: null, appliedFilters: [], exclusions: [], unsupportedFilters: [] },
        cards: [],
        actions: [],
        links: [],
        nextContext: null,
        aiUsed: false
      };
    }
    if (routeInfo.clarifyKind === "switch_mode_reports") {
      return {
        intent: "clarify",
        modeUsed: safeMode,
        headline: en ? "This looks like a CRM / team question — switch to Reports or Auto." : "ده سؤال تقارير / عملاء — حوّل لوضع التقارير أو التلقائي.",
        windowLabel: en ? "Mode mismatch" : "تغيير الوضع",
        understood: { job: "clarify_mode", market: "primary", appliedFilters: [], exclusions: [], unsupportedFilters: [] },
        cards: [],
        actions: [
          { kind: "pivot_mode", mode: "reports", label: en ? "Switch to Reports" : "حوّل للتقارير" },
          { kind: "pivot_mode", mode: "auto", label: en ? "Ask in Auto" : "اسأل في التلقائي" }
        ],
        links: [],
        aiUsed: false
      };
    }
    return {
      intent: "clarify",
      modeUsed: safeMode,
      headline: en ? "Which market would you like to search?" : "تحب تدور في أي سوق؟",
      windowLabel: en ? "Choose market" : "اختر السوق",
      understood: { job: "clarify_market", market: null, appliedFilters: [], exclusions: routeInfo.exclusions || [], unsupportedFilters: [] },
      cards: [],
      actions: [
        { kind: "pivot_mode", mode: "resale", label: en ? "Search Resale units" : "دور في الريسيل" },
        { kind: "pivot_mode", mode: "primary", label: en ? "Search Primary developer projects" : "دور في مشاريع المطورين (برايمري)" }
      ],
      links: [],
      aiUsed: false
    };
  }

  if (routeInfo.route === "crm_leads") {
    const r = await runCrmLeads(pool, actor, routeInfo.queueHint, en);
    return { modeUsed: safeMode, ...r };
  }
  if (routeInfo.route === "crm_opened_no_followup") {
    const r = await runOpenedNoFollowup(pool, actor, en);
    return { modeUsed: safeMode, ...r };
  }
  if (routeInfo.route === "crm_approaching_sla") {
    const r = await runApproachingSla(pool, actor, now, en);
    return { modeUsed: safeMode, ...r };
  }
  if (routeInfo.route === "crm_stuck_brokers") {
    const r = await runStuckBrokers(pool, actor, routeInfo, now, en);
    return { modeUsed: safeMode, ...r };
  }
  if (routeInfo.route === "crm_discipline" || routeInfo.route === "crm_broker" || routeInfo.route === "crm_team") {
    const r = await runDisciplineOrBroker(pool, actor, routeInfo, now, en, cleanText);
    return { modeUsed: safeMode, ...withSummaries(r, en) };
  }
  if (routeInfo.route === "crm_prices") {
    // Budget: stated in the question (local parser, no AI) or carried from the search before.
    const budget = Q.fallbackParse(cleanText)?.filters?.price_max || Number(previousContext?.maxPrice) || null;
    return { modeUsed: safeMode, ...(await runPrices(pool, actor, routeInfo, en, budget)) };
  }
  if (routeInfo.route === "compare") {
    return { modeUsed: safeMode, ...(await runCompare(pool, actor, previousContext, routeInfo, en)) };
  }
  if (routeInfo.route.startsWith("crm_")) {
    const r = await runExecutiveReport(pool, actor, routeInfo, now, en, cleanText);
    return { modeUsed: safeMode, ...withSummaries(r, en) };
  }

  if (routeInfo.route === "inventory_count") {
    const marketLock = routeInfo.market || "resale";
    const searchCtx = ViewGuard.active() ? { lang } : { pool, AI, broker: actor, agency, lang };
    const unitText = Router.normalize(cleanText)
      .replace(/^(?:how many|count|total)\s+/i, "")
      .replace(/\b(?:available|do we have|we have|are there|in stock|in inventory)\b/gi, " ")
      .replace(/^(?:كام|كم|عدد)\s+/, "")
      .replace(/\b(?:متاحه|متاح|عندنا|موجوده|موجود|في المخزون)\b/g, " ")
      .replace(/[؟?!.,]+$/g, "")
      .replace(/\s+/g, " ")
      .trim() || cleanText;
    const found = await Search.search({ pool, AI, agencyId: actor.agency_id, text: unitText, ctx: searchCtx, pageSize: 20, market: marketLock, allowDrop: true });
    const rows = Array.isArray(found.rows) ? found.rows : [];
    const total = Math.min(found.total || 0, Search.SNAPSHOT_MAX);
    const appliedFilters = buildUnitAppliedFilters(found.parsed?.filters, marketLock, en);
    const unapplied = found.parsed?.meta?.unapplied || [];
    const reading = found.parsed?.filters ? String(formatInterpretation(found.parsed, lang) || "").replace(/\*/g, "") : "";
    const f = found.parsed?.filters ? SearchLink.encodeFilters(found.parsed.filters) : null;
    const photos = rows.length
      ? (await pool.query("SELECT DISTINCT ON (listing_id) listing_id, url FROM listing_images WHERE listing_id = ANY($1::uuid[]) AND agency_id = $2 ORDER BY listing_id, position", [rows.map((r) => r.id), actor.agency_id])).rows
      : [];
    const photoOf = new Map(photos.map((p) => [p.listing_id, Storage.photoUrl(p.url)]));
    const thumbOf = new Map(photos.map((p) => [p.listing_id, Storage.thumbUrl(p.url)]));
    const items = rows.map((r) => unitDto(r, actor.id, photoOf, thumbOf));
    return {
      intent: "inventory_count",
      modeUsed: safeMode,
      headline: en ? `${total} matching available unit(s)` : `عندنا ${total} وحدة متاحة مطابقة`,
      windowLabel: reading,
      understood: {
        job: "inventory_count",
        market: found.parsed?.filters?.market || marketLock,
        appliedFilters,
        filters: structuredUnitFilters(found.parsed?.filters),
        exclusions: routeInfo.exclusions || [],
        unsupportedFilters: unapplied
      },
      cards: [{
        kind: "metric_row",
        items: [{ label: en ? "Available units" : "وحدات متاحة", value: total, tone: total ? "ok" : "neutral" }]
      }],
      units: { status: items.length ? "results" : "none", total, marketLock, reading, f, items },
      actions: total === 0 && marketLock === "resale" ? [{ kind: "pivot_mode", mode: "primary", label: en ? "Search Primary projects instead?" : "تدور في مشاريع المطورين (برايمري)؟" }] : [],
      links: [{ label: en ? "Open all units" : "كل الوحدات", screen: "UnitsList", params: {} }],
      aiUsed: found.source === "ai"
    };
  }

  if (routeInfo.route === "primary") {
    const data = await ProjectSearch.fromQuery(pool, actor, { q: cleanText }, { AI }).catch(() => null);
    // 1-3 projects that all have priced unit offers: the code-built answer line says it all, so the AI call is skipped (cost).
    const complete = Boolean(data) && data.total_projects >= 1 && data.total_projects <= 3 && data.projects?.length === data.total_projects
      && data.projects.every((p) => p.offers_total > 0 && p.offers?.length > 0 && p.offers.every((o) => o.price > 0));
    const out = complete ? {} : await Assistant.ask(pool, actor, cleanText, { channel: "app", results: data }).catch((err) => ({ error: err?.code || "ai" }));
    const local = data ? AnswerLine.line(data, lang) : "";
    const answerText = out.answer || local || (en ? "No matching project information found in your catalogue." : "مفيش معلومات مطابقة في كتالوج المشاريع.");
    const aiUsed = Boolean(out.answer && !out.error && out.question_id);
    return {
      intent: "primary",
      modeUsed: safeMode,
      headline: en ? "Primary & Developer Projects" : "مشاريع المطورين (برايمري)",
      windowLabel: data?.total_projects ? (en ? `${data.total_projects} matching project(s)` : `${data.total_projects} مشروع مطابق`) : "",
      understood: {
        job: "project_info",
        market: "primary",
        appliedFilters: [en ? "Market: Primary projects" : "السوق: مشاريع المطورين"],
        exclusions: routeInfo.exclusions || [],
        unsupportedFilters: []
      },
      cards: [{
        kind: "text_answer",
        answer: answerText,
        dataDates: out.dates ? Assistant.datesLine(out.dates, lang) : null,
        found: Boolean(out.found ?? data?.total_projects),
        source: aiUsed ? "ai" : "local",
        logId: data?.log_id || null
      }],
      projects: data && data.total_projects > 0 ? { ...data, answer_line: local } : null,
      actions: [],
      links: [{ label: en ? "Projects" : "المشاريع", screen: "Projects", params: {} }],
      aiUsed
    };
  }

  // Default & `resale` lock: strictly unit search without mixing Primary project Q&A.
  const explicitResale = /\bresale\b|ريسيل|اعاده البيع/.test(Router.normalize(cleanText));
  const marketLock = safeMode === "resale" || explicitResale || routeInfo.market === "resale" ? "resale" : null;
  const searchCtx = ViewGuard.active() ? { lang } : { pool, AI, broker: actor, agency, lang };
  let searchText = cleanText;
  let parsedOverride = null;
  if (routeInfo.budgetBump) {
    searchText = routeInfo.budgetBump.baseQuery || cleanText;
    const decoded = routeInfo.budgetBump.f ? SearchLink.decodeFilters(routeInfo.budgetBump.f) : null;
    const baseMax = decoded
      ? (decoded.price_max != null ? Number(decoded.price_max) : Number(routeInfo.budgetBump.baseMaxPrice || 0))
      : Number(routeInfo.budgetBump.baseMaxPrice || 0);
    if (!decoded || !(baseMax > 0)) {
      return {
        intent: "clarify",
        modeUsed: safeMode,
        headline: en
          ? "Your previous search did not set a maximum budget — include the full budget (e.g. \"under 6 million\")."
          : "البحث اللي فات مكانش فيه حد أقصى للميزانية — اكتب الميزانية الجديدة كاملة (مثلاً: \"بحد أقصى ٦ مليون\").",
        windowLabel: en ? "Missing budget baseline" : "مفيش ميزانية سابقة",
        cards: [],
        actions: searchText ? [{ kind: "change_search", label: en ? "Edit search" : "تعديل البحث", query: searchText }] : [],
        links: [],
        nextContext: null,
        aiUsed: false
      };
    }
    decoded.price_max = Math.round(baseMax + routeInfo.budgetBump.delta);
    parsedOverride = { intent: "search", transcript: searchText, language: lang, filters: decoded, meta: {} };
  }
  const found = await Search.search({
    pool,
    AI,
    agencyId: actor.agency_id,
    text: searchText,
    ctx: searchCtx,
    pageSize: 20,
    market: marketLock,
    ...(parsedOverride ? { parsedOverride } : {})
  });
  const rows = Array.isArray(found.rows) ? found.rows : [];
  const photos = rows.length
    ? (await pool.query("SELECT DISTINCT ON (listing_id) listing_id, url FROM listing_images WHERE listing_id = ANY($1::uuid[]) AND agency_id = $2 ORDER BY listing_id, position", [rows.map((r) => r.id), actor.agency_id])).rows
    : [];
  const photoOf = new Map(photos.map((p) => [p.listing_id, Storage.photoUrl(p.url)]));
  const thumbOf = new Map(photos.map((p) => [p.listing_id, Storage.thumbUrl(p.url)]));
  const items = rows.map((r) => unitDto(r, actor.id, photoOf, thumbOf));
  const reading = found.parsed?.filters ? String(formatInterpretation(found.parsed, lang) || "").replace(/\*/g, "") : "";
  const f = found.parsed?.filters ? SearchLink.encodeFilters(found.parsed.filters) : null;
  const aiUsed = found.source === "ai";
  const effectiveMarketLock = found.parsed?.filters?.market || marketLock || null;
  const appliedFilters = buildUnitAppliedFilters(found.parsed?.filters, effectiveMarketLock, en);
  const guesses = (found.parsed?.meta?.guesses || []).map((g) => ({ typed: g.typed, as: g.as }));
  const unapplied = found.parsed?.meta?.unapplied || [];
  const ignoredTerms = found.ignoredTerms || [];
  const sort = found.parsed?.filters?.sort || null;
  const total = Math.min(found.total || 0, Search.SNAPSHOT_MAX);
  const effectiveMaxPrice = found.parsed?.filters?.price_max ?? null;
  const searchNextContext = {
    job: "find_units",
    market: effectiveMarketLock,
    maxPrice: effectiveMaxPrice,
    f,
    originalQuery: searchText,
    unitCodes: rows.slice(0, 5).map((r) => r.code).filter(Boolean)
  };
  const understood = {
    job: "find_units",
    market: effectiveMarketLock,
    appliedFilters,
    filters: structuredUnitFilters(found.parsed?.filters),
    exclusions: routeInfo.exclusions || [],
    unsupportedFilters: unapplied
  };

  let counts;
  if (found.status === "results" || found.status === "none") {
    counts = { active: found.total || 0, sold: 0, archived: 0 };
    const others = Search.SEARCH_STATUSES.filter((x) => x !== "active");
    (await Promise.all(others.map((other) => Search.countByStatus(pool, actor.agency_id, found.parsed, other, found.fx)))).forEach((n, i) => (counts[others[i]] = n));
  }

  if (!items.length && found.status !== "ask") {
    return {
      intent: "unit_search",
      modeUsed: safeMode,
      headline: en ? "No matching Resale units found" : "مفيش وحدات ريسيل مطابقة دلوقتي",
      windowLabel: reading,
      understood,
      units: { status: "none", total: 0, counts, statusCounts: counts, marketLock: effectiveMarketLock, sort, relaxed: Boolean(found.relaxed), reading, f, guesses, unapplied, ignoredTerms, items: [] },
      cards: [],
      suggestPrimary: true,
      actions: [
        ...(effectiveMarketLock === "resale" ? [{ kind: "view_all_markets", label: en ? "View all markets" : "عرض كل الأسواق" }] : []),
        { kind: "pivot_mode", mode: "primary", label: en ? "Search Primary projects instead?" : "تدور في مشاريع المطورين (برايمري)؟" }
      ],
      links: [{ label: en ? "Unit filters" : "فلاتر الوحدات", screen: "UnitsList", params: {} }],
      nextContext: searchNextContext,
      aiUsed
    };
  }

  return {
    intent: "unit_search",
    modeUsed: safeMode,
    headline: en ? `${total || items.length} unit(s) found` : `لقينا ${total || items.length} وحدة`,
    windowLabel: reading,
    understood,
    units: {
      status: found.status === "ask" ? "ask" : "results",
      total,
      counts,
      statusCounts: counts,
      marketLock: effectiveMarketLock,
      sort,
      relaxed: Boolean(found.relaxed),
      reading,
      f,
      guesses,
      unapplied,
      ignoredTerms,
      ...(found.ask ? { ask: found.ask } : {}),
      items
    },
    cards: [],
    suggestPrimary: safeMode === "resale",
    actions: safeMode === "resale" ? [{ kind: "pivot_mode", mode: "primary", label: en ? "Check Primary projects too?" : "تشوف مشاريع برايمري كمان؟" }] : [],
    links: [{ label: en ? "Open all units" : "كل الوحدات", screen: "UnitsList", params: {} }],
    nextContext: searchNextContext,
    aiUsed
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Adds `avatarUrl` (null when unset) to every broker named in the answer's cards; only this agency's brokers are looked up. */
async function withAvatars(pool, actor, answer) {
  const refs = [];
  for (const c of answer?.cards || []) {
    for (const i of c.items || []) if (i.assigneeId) refs.push([i, i.assigneeId]);
    for (const r of c.recommendedBrokers || []) refs.push([r, r.id]);
    for (const r of c.rows || []) if (UUID.test(r.key || "")) refs.push([r, r.key]);
    if (c.kind === "broker_scorecard" && c.broker?.id) refs.push([c.broker, c.broker.id]);
  }
  if (!refs.length || !actor?.agency_id) return answer;
  const { rows } = await pool.query("SELECT id, avatar_path FROM brokers WHERE agency_id = $1 AND id = ANY($2::uuid[])", [actor.agency_id, [...new Set(refs.map(([, id]) => id))]]);
  const path = new Map(rows.map((r) => [r.id, r.avatar_path]));
  for (const [o, id] of refs) o.avatarUrl = require("../lib/supabase").photoUrl(path.get(id));
  return answer;
}

/** Every answer carries follow-up chips (domain/assistantSuggestions), so no reply is a dead end. */
async function query(pool, params) {
  // The request language wins over the profile language for the answer text.
  if (params.lang === "en" || params.lang === "ar") params = { ...params, actor: { ...params.actor, preferred_lang: params.lang } };
  const r = await withAvatars(pool, params.actor, await queryInner(pool, params));
  if (!r || r.error) return r;
  const actor = params.actor;
  const role = Authz.isDataEntry(actor) ? "data_entry" : isManagerOrOwner(actor) ? "manager" : isTeamLead(actor) ? "team_lead" : "broker";
  const suggestions = Suggest.suggestionsFor({
    intent: r.notForRole ? "not_for_role" : r.intent,
    kind: r.intent === "unit_search" && r.units?.status === "none" ? "none" : undefined,
    role,
    lang: langOf(actor),
    solo: !hasMultiBrokerScope(actor),
    context: r.nextContext
  });
  return { ...r, suggestions };
}

module.exports = { query, withAvatars };
