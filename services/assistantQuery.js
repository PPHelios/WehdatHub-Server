// services/assistantQuery.js — Orchestrates POST /api/v1/assistant/query: deterministic zero-credit CRM/Resale
// execution first, falling back to Gemini Primary/Q&A only when needed, strictly scoped by agency_id, role & workspace.
"use strict";

const Router = require("../domain/assistantRouter");
const Authz = require("../lib/authz");
const Segments = require("../domain/segments");
const Vis = require("../lib/visibility");
const Dash = require("./dashboards");
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

const isManagerOrOwner = (b) => Authz.isManager(b);
const isTeamLead = (b) => Authz.isTeamLead(b);
const langOf = (b) => (b?.preferred_lang === "en" ? "en" : "ar");

function allowsFeature(actor, feature) {
  return !actor?.workspace || Segments.allows(actor.workspace, feature);
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
  const canNudge = isManagerOrOwner(actor) || isTeamLead(actor);
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
  if (windowInfo && windowInfo.since && windowInfo.until) {
    return {
      since: new Date(windowInfo.since),
      until: new Date(windowInfo.until),
      labelEn: windowInfo.labelEn,
      labelAr: windowInfo.labelAr,
      daysSpan: Math.max(1, Math.round((new Date(windowInfo.until).getTime() - new Date(windowInfo.since).getTime()) / DAY_MS))
    };
  }
  return {
    since: new Date(now.getTime() - defaultDays * DAY_MS),
    until: now,
    labelEn: `Last ${defaultDays} days`,
    labelAr: `آخر ${defaultDays} يوم`,
    daysSpan: defaultDays
  };
}

async function runDisciplineOrBroker(pool, actor, routeInfo, now, en) {
  if (!isManagerOrOwner(actor) && !isTeamLead(actor)) {
    return {
      intent: "clarify",
      headline: en ? "Team performance is limited to managers and team leads." : "تقارير أداء الفريق متاحة للمديرين وقادة الفرق بس.",
      windowLabel: en ? "Access scope" : "الصلاحيات",
      cards: [],
      actions: [],
      links: [{ label: en ? "My leads" : "عملائي", screen: "LeadsList", params: {} }],
      aiUsed: false
    };
  }
  const { route, brokerQuery, teamQuery, windowInfo } = routeInfo;
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
    const hit = tls.find((t) => Router.normalize(t.name).includes(qTeam));
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
        { kind: "broker_discipline", summary, rows: board.slice(0, 8) }
      ],
      actions: [],
      links: [{ label: en ? "Team" : "الفريق", screen: "Team", params: {} }],
      aiUsed: false
    };
  }

  if (route === "crm_broker") {
    const q = Router.normalize(brokerQuery || "");
    const match = q ? board.find((b) => Router.normalize(b.name).includes(q)) : null;
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

async function runExecutiveReport(pool, actor, routeInfo, now, en) {
  const { route, windowInfo, sourceFilter } = routeInfo;
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
      `SELECT l.ref, l.stage, l.next_follow_up_at, b.name AS broker_name, u.code AS unit_code
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
      byBroker.set(k, (byBroker.get(k) || 0) + 1);
    }
    return {
      intent: "crm_viewings",
      headline: en ? `${rows.length} viewing(s) scheduled · ${range.labelEn}` : `${rows.length} معاينة مجدولة · ${range.labelAr}`,
      windowLabel: en ? range.labelEn : range.labelAr,
      cards: [
        {
          kind: "metric_row",
          items: [
            { label: en ? "Viewings" : "المعاينات", value: rows.length, tone: rows.length ? "ok" : "neutral" },
            { label: en ? "Brokers active" : "وسطاء عندهم معاينات", value: byBroker.size, tone: "neutral" }
          ]
        },
        ...(byBroker.size
          ? [{
              kind: "bar_breakdown",
              title: en ? "By broker" : "حسب البروكر",
              rows: [...byBroker.entries()].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ key: label, label, count }))
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
        headline: en ? "Response time breakdowns are available to managers and team leads." : "تقارير وقت الرد متاحة للمديرين وقادة الفرق بس.",
        windowLabel: en ? "Role scope" : "الصلاحيات",
        cards: [],
        actions: [],
        links: [{ label: en ? "My leads" : "عملائي", screen: "LeadsList", params: {} }],
        aiUsed: false
      };
    }
    const range = resolveRange(windowInfo, now, 30);
    const params = [actor.agency_id, range.since.toISOString(), range.until.toISOString()];
    let teamSql = "";
    if (isTeamLead(actor) && !isManagerOrOwner(actor)) {
      params.push(actor.id);
      teamSql = ` AND (l.assigned_broker_id = $${params.length} OR l.assigned_broker_id IN (SELECT id FROM brokers WHERE agency_id = $1 AND team_lead_id = $${params.length}))`;
    }
    const { rows: rawRows } = await pool.query(
      `WITH base AS (
         SELECT l.assigned_broker_id AS broker_id, coalesce(b.name, '—') AS broker_name,
                extract(epoch FROM (coalesce(fc.at, l.last_contact_at) - l.created_at)) / 60 AS mins
           FROM leads l
           JOIN LATERAL (SELECT min(e.created_at) AS at FROM lead_events e
                          WHERE e.lead_id = l.id AND e.agency_id = l.agency_id AND e.kind = 'contacted' AND e.undone_at IS NULL) fc ON true
           LEFT JOIN brokers b ON b.id = l.assigned_broker_id
          WHERE ${Vis.leads("l")} AND l.agency_id = $1 AND l.assigned_broker_id IS NOT NULL
            AND l.created_at >= $2 AND l.created_at < $3 AND coalesce(fc.at, l.last_contact_at) >= l.created_at${teamSql}
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
        ORDER BY sort_grp, avg_min ASC NULLS LAST`,
      params
    );
    const overallRow = rawRows.find((r) => r.broker_id === null && r.broker_name === "__overall__");
    const rows = rawRows.filter((r) => !(r.broker_id === null && r.broker_name === "__overall__"));
    const totalResp = Number(overallRow?.responded || 0);
    const weightedAvg = overallRow?.avg_min == null ? null : Number(overallRow.avg_min);
    const overallMed = overallRow?.med_min == null ? null : Number(overallRow.med_min);
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
            { label: en ? "Average (min)" : "المتوسط (د)", value: weightedAvg ?? "—", tone: weightedAvg != null && weightedAvg <= 30 ? "ok" : "warn" },
            { label: en ? "Median (min)" : "الوسيط (د)", value: overallMed ?? "—", tone: "neutral" },
            { label: en ? "Contacted" : "اتكلموا", value: totalResp, tone: "neutral" }
          ]
        },
        ...(rows.length
          ? [{
              kind: "bar_breakdown",
              title: en ? "Per person (average min)" : "لكل بروكر (متوسط الدقايق)",
              rows: rows.map((r) => ({ key: String(r.broker_id), label: r.broker_name, count: Number(r.avg_min || 0), valueLabel: `${r.avg_min}m avg · ${r.med_min}m med` }))
            }]
          : [])
      ],
      actions: [],
      links: isManagerOrOwner(actor) ? [{ label: en ? "Broker rankings" : "ترتيب الوسطاء", screen: "Dashboard", params: {} }] : [],
      aiUsed: false
    };
  }

  if (!isManagerOrOwner(actor)) {
    return {
      intent: "clarify",
      headline: en ? "Agency financial and marketing totals are available to managers only." : "تقارير العمولات والتسويق متاحة للمديرين وصاحب الشركة بس.",
      windowLabel: en ? "Role scope" : "الصلاحيات",
      cards: [],
      actions: [],
      links: [{ label: en ? "My leads" : "عملائي", screen: "LeadsList", params: {} }],
      aiUsed: false
    };
  }
  if (route === "crm_commissions") {
    const page = await Commissions.pageCommissions(pool, actor, { limit: 5, now });
    const t = page?.totals || { count: 0, expected: 0, claimed: 0, paid: 0, outstanding: 0, overdue: 0 };
    return {
      intent: "crm_commissions",
      headline: en ? `Developer commissions · ${Number(t.outstanding || 0).toLocaleString("en-US")} EGP outstanding` : `عمولات المطورين · ${Number(t.outstanding || 0).toLocaleString("en-US")} ج.م مستحق`,
      windowLabel: en ? "All active commissions" : "كل العمولات القائمة",
      cards: [
        {
          kind: "metric_row",
          items: [
            { label: en ? "Outstanding" : "الباقي", value: Number(t.outstanding || 0), tone: t.overdue ? "critical" : "warn", unit: "EGP" },
            { label: en ? "Paid" : "المدفوع", value: Number(t.paid || 0), tone: "ok", unit: "EGP" },
            { label: en ? "Overdue" : "متأخرة", value: Number(t.overdue || 0), tone: t.overdue ? "critical" : "neutral" }
          ]
        }
      ],
      actions: [],
      links: [{ label: en ? "Open Commissions" : "افتح العمولات", screen: "Commissions", params: {} }],
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

  // crm_brief: executive snapshot (windowed when user asks today / week / month)
  const range = resolveRange(windowInfo, now, 30);
  if (windowInfo) {
    const rows = await Dash.brokerActivity(pool, actor.agency_id, { since: range.since, until: range.until });
    const agg = rows.filter((b) => b.active !== false).reduce(
      (s, b) => ({
        calls: s.calls + Number(b.calls || 0),
        viewings: s.viewings + Number(b.viewings || 0),
        updates: s.updates + Number(b.updates || 0),
        leads: s.leads + Number(b.leads || 0),
        deals: s.deals + Number(b.deals || 0)
      }),
      { calls: 0, viewings: 0, updates: 0, leads: 0, deals: 0 }
    );
    return {
      intent: "crm_brief",
      headline: en
        ? `Agency activity · ${agg.calls} calls · ${agg.viewings} viewings · ${agg.deals} deals`
        : `نشاط الشركة · ${agg.calls} مكالمة · ${agg.viewings} معاينة · ${agg.deals} صفقة`,
      windowLabel: en ? range.labelEn : range.labelAr,
      cards: [
        {
          kind: "metric_row",
          items: [
            { label: en ? "Calls" : "مكالمات", value: agg.calls, tone: "neutral" },
            { label: en ? "Viewings" : "معاينات", value: agg.viewings, tone: "neutral" },
            { label: en ? "Updates" : "تحديثات", value: agg.updates, tone: "ok" },
            { label: en ? "New leads" : "عملاء جدد", value: agg.leads, tone: "neutral" },
            { label: en ? "Deals" : "صفقات", value: agg.deals, tone: agg.deals ? "ok" : "neutral" }
          ]
        }
      ],
      actions: [],
      links: [{ label: en ? "Open Dashboard" : "افتح لوحة الأداء", screen: "Dashboard", params: {} }],
      aiUsed: false
    };
  }
  const d = await Dash.agencyDashboard(pool, actor, { days: 30, now });
  return {
    intent: "crm_brief",
    headline: en
      ? `Agency brief · ${d.deals.n} deals · ${d.waitingOver1h || 0} waiting > 1h`
      : `ملخص الشركة · ${d.deals.n} صفقة · ${d.waitingOver1h || 0} مستني > ساعة`,
    windowLabel: en ? "Last 30 days" : "آخر ٣٠ يوم",
    cards: [
      {
        kind: "metric_row",
        items: [
          { label: en ? "New leads" : "عملاء جدد", value: Number(d.leads || 0), tone: "neutral" },
          { label: en ? "Waiting > 1h" : "مستني > ساعة", value: Number(d.waitingOver1h || 0), tone: d.waitingOver1h ? "critical" : "ok" },
          { label: en ? "Overdue" : "متأخرة", value: Number(d.overdue || 0), tone: d.overdue ? "critical" : "ok" },
          { label: en ? "Deals" : "صفقات", value: Number(d.deals?.n || 0), tone: d.deals?.n ? "ok" : "neutral" }
        ]
      }
    ],
    actions: [],
    links: [{ label: en ? "Open Dashboard" : "افتح لوحة الأداء", screen: "Dashboard", params: {} }],
    aiUsed: false
  };
}

/**
 * Executes a single assistant query across Resale units, Primary projects, or CRM/Executive reports.
 */
async function query(pool, { AI, actor, agency = null, text, mode = "auto", now = new Date() }) {
  const en = langOf(actor) === "en";
  const lang = en ? "en" : "ar";
  const safeMode = Router.MODES.includes(mode) ? mode : "auto";
  const cleanText = String(text || "").trim().slice(0, 500);
  if (!cleanText) return { error: "empty" };

  const routeInfo = Router.classifyAssistantQuery({ text: cleanText, mode: safeMode, now });
  if (Authz.isDataEntry(actor) && routeInfo.route !== "unit_search") {
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

  if (routeInfo.route === "crm_leads") {
    const r = await runCrmLeads(pool, actor, routeInfo.queueHint, en);
    return { modeUsed: safeMode, ...r };
  }
  if (routeInfo.route === "crm_discipline" || routeInfo.route === "crm_broker" || routeInfo.route === "crm_team") {
    const r = await runDisciplineOrBroker(pool, actor, routeInfo, now, en);
    return { modeUsed: safeMode, ...r };
  }
  if (routeInfo.route.startsWith("crm_")) {
    const r = await runExecutiveReport(pool, actor, routeInfo, now, en);
    return { modeUsed: safeMode, ...r };
  }

  if (routeInfo.route === "primary") {
    const data = await ProjectSearch.fromQuery(pool, actor, { q: cleanText }, { AI }).catch(() => null);
    const out = await Assistant.ask(pool, actor, cleanText, { channel: "app", results: data }).catch((err) => ({ error: err?.code || "ai" }));
    const local = data ? AnswerLine.line(data, lang) : "";
    const answerText = out.answer || local || (en ? "No matching project information found in your catalogue." : "مفيش معلومات مطابقة في كتالوج المشاريع.");
    const aiUsed = Boolean(out.answer && !out.error && out.question_id);
    return {
      intent: "primary",
      modeUsed: safeMode,
      headline: en ? "Primary & Developer Projects" : "مشاريع المطورين (برايمري)",
      windowLabel: data?.total_projects ? (en ? `${data.total_projects} matching project(s)` : `${data.total_projects} مشروع مطابق`) : "",
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
  const marketLock = safeMode === "resale" || explicitResale ? "resale" : null;
  const searchCtx = ViewGuard.active() ? { lang } : { pool, AI, broker: actor, agency, lang };
  const found = await Search.search({
    pool,
    AI,
    agencyId: actor.agency_id,
    text: cleanText,
    ctx: searchCtx,
    pageSize: 20,
    market: marketLock
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
  const guesses = (found.parsed?.meta?.guesses || []).map((g) => ({ typed: g.typed, as: g.as }));
  const unapplied = found.parsed?.meta?.unapplied || [];
  const ignoredTerms = found.ignoredTerms || [];
  const sort = found.parsed?.filters?.sort || null;
  const total = Math.min(found.total || 0, Search.SNAPSHOT_MAX);

  let counts;
  if (found.status === "results" || found.status === "none") {
    counts = { active: 0, sold: 0, archived: 0, active: found.total || 0 };
    const others = Search.SEARCH_STATUSES.filter((x) => x !== "active");
    (await Promise.all(others.map((other) => Search.countByStatus(pool, actor.agency_id, found.parsed, other, found.fx)))).forEach((n, i) => (counts[others[i]] = n));
  }

  if (!items.length && found.status !== "ask") {
    return {
      intent: "unit_search",
      modeUsed: safeMode,
      headline: en ? "No matching Resale units found" : "مفيش وحدات ريسيل مطابقة دلوقتي",
      windowLabel: reading,
      units: { status: "none", total: 0, counts, marketLock: effectiveMarketLock, sort, relaxed: Boolean(found.relaxed), reading, f, guesses, unapplied, ignoredTerms, items: [] },
      cards: [],
      suggestPrimary: true,
      actions: [{ kind: "pivot_mode", mode: "primary", label: en ? "Search Primary projects instead?" : "تدور في مشاريع المطورين (برايمري)؟" }],
      links: [{ label: en ? "Unit filters" : "فلاتر الوحدات", screen: "UnitsList", params: {} }],
      aiUsed
    };
  }

  return {
    intent: "unit_search",
    modeUsed: safeMode,
    headline: en ? `${total || items.length} unit(s) found` : `لقينا ${total || items.length} وحدة`,
    windowLabel: reading,
    units: {
      status: found.status === "ask" ? "ask" : "results",
      total,
      counts,
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
    aiUsed
  };
}

module.exports = { query };
