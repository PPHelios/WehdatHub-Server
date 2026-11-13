// web/routes/search.js — Web search on services/search.js (same filters, same SQL, same order as WhatsApp),
// "refine and see all" (?f=<filters token> from WhatsApp links) and saved searches.
"use strict";

const Switches = require("../../services/aiSwitches");
const Shadow = require("../../services/searchShadow");
const Search = require("../../services/search");
const Saved = require("../../services/savedSearches");
const SearchLog = require("../../services/searchLog");
const AI = require("../../lib/ai");
const Store = require("../../lib/listingStore");
const RateLimit = require("../../lib/rateLimit");
const { logOperation } = require("../../lib/db");
const { formatInterpretation } = require("../../lib/search");
const Q = require("../../domain/searchQuery");
const SearchLink = require("../../domain/searchLink");
const { uploads, VOICE } = require("../uploads");
const AiBlock = require("../../lib/aiBlock");
const { isAgencyOwner, isDataEntry, canEdit } = require("../../lib/authz");
const Vis = require("../../lib/visibility");
const { html, raw } = require("../html");
const { icon } = require("../icons");
const { resultItem } = require("../views/units");
const Privacy = require("../../services/unitPrivacy");
const { refineForm } = require("../views/searchForm");

const WEB_PAGE_SIZE = 20;
const MAX_SAVED = Saved.MAX_SAVED;
const MAX_SPOKEN_SEARCH = 200;
const FORM_KEYS = ["code", "listing_type", "market", "type", "place", "price_min", "price_max", "area_min", "area_max", "bedrooms_min", "bedrooms_max", "bathrooms_min", "floor_min", "floor_max", "finishing", "furnishing", "ready", "by_year", "cash", "installments", "max_down_payment", "max_installment", "feature", "other"];

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const stripStars = (s) => String(s || "").replace(/\*/g, "");

/** Runs canonical filters for the agency: strict, then relaxed; the page comes from the id snapshot. */
async function runFilters(pool, agencyId, filters, page, { ask = false, status = "active" } = {}) {
  const res = await Search.runSearch(pool, agencyId, { filters }, { pageSize: WEB_PAGE_SIZE, ask, status });
  const offset = (page - 1) * WEB_PAGE_SIZE;
  const rows = offset === 0 ? res.rows : await Search.pageByIds(pool, agencyId, res.ids, offset, WEB_PAGE_SIZE, { status });
  return { ...res, rows, offset };
}

const STATUS_LABEL = { active: ["متاحة", "Available"], sold: ["مباعة", "Sold"], archived: ["مؤرشفة", "Archived"] };

/** Available · Sold · Archived for the same search, each with how many units fit. The current one is not a link. */
function statusSwitch({ token, st, counts, lang, sl = null }) {
  const href = (s) => `/app/search?f=${token}${s === "active" ? "" : `&st=${s}`}${sl ? `&sl=${sl}` : ""}`;
  return html`<nav class="seg" aria-label="${L(lang, "الحالة", "Status")}" data-status-switch>${["active", "sold", "archived"].map(
    (s) => html`<a href="${href(s)}" data-status="${s}"${s === st ? html` aria-current="page"` : ""}>${L(lang, STATUS_LABEL[s][0], STATUS_LABEL[s][1])} (${counts[s]})</a>`
  )}</nav>`;
}

function searchBox(q, lang, { voice = false } = {}) {
  return html`<form method="get" action="/app/search" class="searchbox" role="search" data-search-form>
  <button type="submit" class="search-icon" aria-label="${L(lang, "بحث", "Search")}">${icon("search", 20)}</button><input name="q" value="${q}" aria-label="${L(lang, "اكتب طلبك زي ما بتكتبه للبوت", "Type your request as you would to the bot")}" placeholder="${L(lang, "شقة 3 غرف في التجمع تحت 9 مليون", "3-bedroom apartment in New Cairo under 9M")}" autocomplete="off" enterkeyhint="search"${voice ? raw(" data-voice-start") : ""}>
  <button type="button" class="mic" data-ai="voice_search" data-mic data-voice-url="/app/search/voice" aria-pressed="false" aria-label="${L(lang, "بحث بالصوت: اضغط تبدأ، واضغط تاني تقف", "Voice search: tap to start, tap again to stop")}" hidden><span class="ico-mic">${icon("mic", 20)}</span><span class="ico-stop">${icon("stop", 20)}</span></button>
  <span class="spin" aria-hidden="true"></span>
  <button type="submit" class="sr-only">${L(lang, "بحث", "Search")}</button>
</form>
<p class="row between small"><span class="muted">${L(lang, "اكتب أو اتكلم زي ما بتكلم البوت.", "Type or speak as you would to the bot.")}</span><a href="/app/searches">${icon("star", 16)} ${L(lang, "البحث المحفوظ", "Saved searches")}</a></p>
`;
}

function pager(token, page, total, lang, sl = null, st = "active") {
  const pages = Math.ceil(Math.min(total, Search.SNAPSHOT_MAX) / WEB_PAGE_SIZE);
  if (pages <= 1) return "";
  const link = (p) => `/app/search?f=${token}&page=${p}${st !== "active" ? `&st=${st}` : ""}${sl ? `&sl=${sl}` : ""}`;
  return html`<nav class="row" aria-label="pages">
  ${page > 1 ? html`<a class="btn secondary" href="${link(page - 1)}">${L(lang, "→ السابق", "← Previous")}</a>` : ""}
  <span class="muted">${page} / ${pages}</span>
  ${page < pages ? html`<a class="btn secondary" href="${link(page + 1)}">${L(lang, "التالي ←", "Next →")}</a>` : ""}
</nav>`;
}

const SOURCE_NOTE = {
  parser: ["⚡ قراءة سريعة، من غير ذكاء اصطناعي", "⚡ Read by the quick reader, no AI used"],
  ai: ["🤖 قرأها الذكاء الاصطناعي", "🤖 Read by the AI"],
  fallback: ["⚡ القراءة السريعة (الذكاء الاصطناعي مش متاح دلوقتي)", "⚡ Quick reader (the AI is not available right now)"]
};

/**
 * What was understood, always above the results: the reading in words, who read it, what could not be applied, and the
 * two buttons (report a wrong search, search again with the AI) when the search is in the log.
 */
function understoodBlock({ meta = {}, source = null, filters, logId = null, q = "", lang, canAsk = false, ignored = [] }) {
  const interp = stripStars(formatInterpretation({ filters }, lang));
  const note = SOURCE_NOTE[source];
  const unapplied = meta.unapplied || [];
  const termWords = (filters.places || []).length ? "" : (filters.place_terms || []).join("، ");
  const guesses = meta.guesses || [];
  return html`<div class="card understood" data-understood>
  <p><strong>🔎 ${L(lang, "فهمت إنك بتدور على", "I understood")}:</strong> ${interp || L(lang, "(مفيش فلتر)", "(no filter)")}</p>
  ${note ? html`<p class="muted small">${L(lang, note[0], note[1])}</p>` : ""}
  ${unapplied.length ? html`<p class="small" data-unapplied>⚠️ ${L(lang, "ما اتطبقش (الفلاتر مش بتدعمه):", "Not applied (filters cannot say it):")} <strong>${unapplied.join("، ")}</strong></p>` : ""}
  ${guesses.length ? html`<p class="muted small" data-guesses>🔤 ${L(lang, "فهمت", "I read")} ${guesses.map((g) => `«${g.typed}» ${L(lang, "على إنها", "as")} «${g.as}»`).join("، ")}</p>` : ""}
  ${ignored.length ? html`<p class="small" data-ignored>ℹ️ ${L(lang, "مفيش عندي", "I could not match")} <strong>${ignored.join("، ")}</strong> ${L(lang, "في المخزون، فدورت من غيرها.", "in your inventory, so I searched without it.")}</p>` : ""}
  ${termWords ? html`<p class="muted small">${L(lang, "كلمات اتدور بيها كاسم مكان:", "Words searched as a place name:")} ${termWords}</p>` : ""}
  ${logId
    ? html`<div class="row">
    <form method="post" action="/app/search/report" class="row"><input type="hidden" name="sl" value="${logId}"><button type="submit" class="secondary small" data-report>🚩 ${L(lang, "البحث ده غلط؟", "Wrong search?")}</button></form>
    ${canAsk && q ? html`<a class="btn secondary small" href="/app/search?q=${encodeURIComponent(q)}&ai=1&sl=${logId}" data-ask-ai data-ai="search_ai">🤖 ${L(lang, "ابحث تاني بالذكاء الاصطناعي", "Search again with AI")}</a>` : ""}
  </div>`
    : ""}
</div>`;
}

/** Words or numbers the search could not place: say so, show how many units fit without them, and offer to go on. */
function askCard({ ask, filters, q, lang, understood, logId }) {
  const interp = stripStars(formatInterpretation({ filters }, lang));
  const words = (ask.terms || []).map((w) => `«${w}»`).join("، ");
  const nums = (ask.numbers || []).map((w) => `«${w}»`).join("، ");
  const go = `/app/search?q=${encodeURIComponent(q)}&drop=1${logId ? `&sl=${logId}` : ""}`;
  return html`${understood}<div class="card notice warn" data-ask-unknown>
  ${words ? html`<p>❓ ${L(lang, "مش عارف", "I do not know")} <strong>${words}</strong>.</p>` : ""}
  ${nums ? html`<p>❓ ${L(lang, "الذكاء الاصطناعي مش متاح دلوقتي ومقدرتش أعرف الرقم", "The AI is not available right now and I could not tell what")} <strong>${nums}</strong> ${L(lang, "ده إيه (سعر؟ قسط؟).", "is (price? installment?).")}</p>` : ""}
  <p>${L(lang, `فيه ${ask.withoutTotal} وحدة من غيرها. أبحث من غيرها ولا تكتبها تاني بالشكل الصح؟`, `${ask.withoutTotal} unit(s) fit without it. Search without it, or retype with the spelling you mean.`)}</p>
  <p><a class="btn" href="${go}" data-search-without>${L(lang, "ابحث من غيرها", "Search without it")}</a></p>
</div>`;
}

function resultsSection({ covers = new Map(), res, filters, token, page, lang, savedId = null, asks = new Map(), understood = "", sl = null, st = "active", switcher = "", restorable = new Set() }) {
  const interp = stripStars(formatInterpretation({ filters }, lang));
  const total = Math.min(res.total, Search.SNAPSHOT_MAX);
  if (!res.rows.length) {
    return html`${understood}${switcher}<div class="card notice"><p>🔍 ${L(lang, "مفيش وحدات مطابقة لـ", "No units match")} <strong>${interp}</strong>. ${L(lang, "جرب ميزانية أوسع أو منطقة قريبة.", "Try a wider budget or a nearby area.")}</p>
${filters.code || st !== "active" || isDataEntry(Vis.viewer()) ? "" : html`<p><a class="btn secondary" href="/app/leads/new?request=${token}" data-save-request>🔔 ${L(lang, "احفظه طلب عميل", "Save as a client's request")}</a> <span class="muted">${L(lang, "وهتتبلغ أول ما تنزل وحدة تناسبه.", "You'll hear when a unit fits.")}</span></p>`}</div>`;
  }
  return html`<section id="results">
  ${understood}
  ${switcher}
  ${res.relaxed ? html`<p class="card notice warn">⚠️ ${L(lang, "مفيش تطابق تام — أقرب النتائج لـ", "No exact match — closest units for")} <strong>${interp}</strong></p>` : ""}
  ${res.rateMissing?.length ? html`<p class="card" role="status">⚠️ ${L(lang, "سعر الدولار/اليورو مش متسجل: حدده من «الاستخدام» عشان أسعار الوحدات بالعملة دي تتطابق.", "The dollar/euro rate is not set: set it under Usage so those prices match.")}</p>` : ""}
  <div class="row between"><p class="muted">${L(lang, `${res.total} وحدة مطابقة`, `${res.total} matching unit(s)`)}${res.total > total ? L(lang, ` (أول ${total})`, ` (first ${total})`) : ""}</p>
  ${savedId || isDataEntry(Vis.viewer())
    ? ""
    : html`<details class="savebox"><summary class="btn secondary small">${icon("star", 16)} ${L(lang, "احفظ البحث", "Save search")}</summary>
    <form method="post" action="/app/searches" class="row">
    <input type="hidden" name="f" value="${token}">
    <label>${L(lang, "اسم البحث", "Name")}<input name="name" required maxlength="80" value="${interp.slice(0, 80)}"></label>
    <button type="submit">${L(lang, "حفظ", "Save")}</button>
  </form></details>`}</div>
  <ol class="results" start="${res.offset + 1}">${res.rows.map((r) => resultItem(r, lang, { thumb: covers.get(r.id), ask: asks.get(r.id) || null, restore: restorable.has(r.code), badge: st === "active" ? "" : L(lang, STATUS_LABEL[st][0], STATUS_LABEL[st][1]), back: `/app/search?f=${token}${st !== "active" ? `&st=${st}` : ""}${page > 1 ? `&page=${page}` : ""}${sl ? `&sl=${sl}` : ""}` }))}</ol>
  ${pager(token, page, res.total, lang, sl, st)}
</section>`;
}

function register(web, { pool, page }) {
  // Whether the AI may read this agency's searches (the owner's switch, services/aiSwitches.js).
  const aiAllowed = (req) => Switches.isOn(pool, req.session.broker.agency_id, "search_ai");
  const searchCtx = (req) => ({ pool, AI, broker: req.session.broker, agency: req.session.agency, lang: langOf(req) });

  web.get("/search", async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const q = String(req.query.q || "").trim().slice(0, 500);
    const pageNo = Math.max(1, Math.min(50, parseInt(req.query.page, 10) || 1));
    let filters = null;
    let message = null;
    let source = "form";
    let parse = null; // the reading of a typed or spoken request
    let logRow = null; // the earlier search a link or a retry belongs to
    const forceAi = req.query.ai === "1";
    const t0 = Date.now();

    // A search link (?f=) is the result of an earlier search: Back and reloads use it without asking the AI again.
    if (q && !req.query.f) {
      const gate = await RateLimit.hit(pool, `search:broker:${broker.id}`, RateLimit.LIMITS.searchBroker);
      if (!gate.allowed) return page(req, res, { title: L(lang, "بحث", "Search"), nav: "search", body: html`${searchBox(q, lang)}<p class="card notice bad">⏳ ${L(lang, "بحث كتير في دقيقة. استنى شوية.", "Too many searches in a minute. Wait a moment.")}</p>` }, 429);
      const parsed = await Search.parseRequest(AI, { text: q, ctx: searchCtx(req), forceAi, aiAllowed: await aiAllowed(req) });
      parse = parsed;
      source = parsed.source;
      const intent = Q.classifyIntent(parsed.parsed);
      if (intent === "search") filters = parsed.parsed.filters;
      else
        message =
          intent === "listing"
            ? L(lang, "📝 شكلها وحدة عايز تضيفها.", "📝 Looks like a unit to add.") + " "
            : L(lang, "👋 اكتب مواصفات اللي بتدور عليه (مثال: شقة 3 غرف في التجمع تحت 8 مليون).", "👋 Type what you are looking for (e.g. 3-bedroom apartment in New Cairo under 8M).");
    } else if (req.query.f) {
      filters = SearchLink.decodeFilters(String(req.query.f));
      if (req.query.sl) logRow = await SearchLog.mine(pool, broker, String(req.query.sl));
      if (!filters) message = L(lang, "⚠️ رابط البحث ده مش صحيح. ابحث من جديد.", "⚠️ This search link is not valid. Search again.");
    } else if (FORM_KEYS.some((k) => req.query[k] !== undefined && req.query[k] !== "")) {
      filters = SearchLink.filtersFromForm(req.query);
    }
    if (filters && !Q.hasAnyFilter({ filters })) {
      filters = null;
      message = L(lang, "اختار فلتر واحد على الأقل.", "Choose at least one filter.");
    }

    let results = "";
    let searchUrl = null;
    if (filters) {
      const token = SearchLink.encodeFilters(filters);
      const noDrop = Boolean(parse) && !req.query.drop;
      // Available is the default; Sold and Archived are the same search for those units (?st=).
      const st = ["sold", "archived"].includes(req.query.st) ? req.query.st : "active";
      const out = await runFilters(pool, broker.agency_id, filters, pageNo, { ask: noDrop, status: st });
      // The AI could not answer and a number was left unplaced: ask first, never search as if it were not there.
      const numbers = noDrop && parse.source === "fallback" ? parse.local?.meta?.leftover_numbers || [] : [];
      if (numbers.length) out.ask = { terms: out.ask?.terms || [], numbers, aiDown: true, withoutTotal: out.ask ? out.ask.withoutTotal : out.total };
      // A new search is logged; a link back to one (Back, a page, a reload) shows the earlier log row's reading.
      let logId = logRow?.id || null;
      if (!req.query.f) {
        logId = await SearchLog.record(pool, {
          broker,
          channel: req.query.voice === "1" ? "voice" : "web",
          text: q,
          parse: parse ? { ...parse, ask: out.ask, timings: { parseMs: parse.ms, dbMs: out.dbMs } } : { source: "form", timings: { dbMs: out.dbMs } },
          startedAt: t0,
          used: filters,
          total: out.ask ? 0 : out.total,
          ids: out.ids,
          relaxed: out.relaxed,
          rerunOf: forceAi ? req.query.sl : null
        });
        if (parse) Shadow.schedule(pool, AI, { logId, text: q, parse });
      }
      const understood = understoodBlock({
        meta: parse ? parse.parsed.meta : { unapplied: logRow?.unapplied || [] },
        source: parse ? parse.source : logRow?.source || null,
        filters,
        logId,
        q: parse ? q : "",
        lang,
        canAsk: Boolean(parse) && parse.source !== "ai",
        ignored: out.ignoredTerms || []
      });
      let switcher = "";
      if (!out.ask) {
        const counts = { active: 0, sold: 0, archived: 0, [st]: out.total };
        for (const other of Search.SEARCH_STATUSES.filter((s) => s !== st)) counts[other] = await Search.countByStatus(pool, broker.agency_id, { filters }, other);
        switcher = statusSwitch({ token, st, counts, lang, sl: logId });
      }
      results = out.ask
        ? askCard({ ask: out.ask, filters, q, lang, understood, logId })
        : resultsSection({ covers: await Store.coverImages(pool, broker.agency_id, out.rows), res: out, filters, token, page: pageNo, lang, asks: await Privacy.askStates(pool, broker, out.rows), understood, sl: logId, st, switcher, restorable: new Set(st === "active" ? [] : out.rows.filter((r) => canEdit(broker, r)).map((r) => r.code)) });
      searchUrl = `/app/search?f=${token}${st !== "active" ? `&st=${st}` : ""}${pageNo > 1 ? `&page=${pageNo}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}${logId ? `&sl=${logId}` : ""}`;
      logOperation(pool, {
        agency_id: broker.agency_id,
        broker_id: broker.id,
        operation_type: "search_query",
        status: out.rows.length ? "success" : "zero_matches",
        total_duration_ms: Date.now() - t0,
        db_ms: out.dbMs,
        metadata: { channel: "web", source, filters, total_count: out.total, relaxed: out.relaxed, page: pageNo }
      });
    }

    return page(req, res, {
      title: L(lang, "بحث", "Search"),
      nav: "search",
      body: html`${searchUrl ? html`<span data-search-url="${searchUrl}" hidden></span>` : ""}${searchBox(q, lang, { voice: req.query.voice === "1" })}
${refineForm(filters || {}, lang)}
${message ? html`<p class="card notice">${message}${message.startsWith("📝") ? html` <a href="/app/units/new">${L(lang, "إضافة وحدة", "Add a unit")}</a>` : ""}</p>` : ""}
${results}`
    });
  });

  // "Wrong search?": one tap keeps the sentence, both readings and the result count for review.
  web.post("/search/report", async (req, res) => {
    const lang = langOf(req);
    const r = await SearchLog.report(pool, req.session.broker, String(req.body.sl || ""), req.body.note);
    const ok = r.ok || r.error === "again";
    return page(req, res, {
      title: L(lang, "بحث", "Search"),
      nav: "search",
      body: html`<p class="card notice ${ok ? "ok" : "bad"}">${ok ? L(lang, "🚩 اتسجل. شكرا، هنراجعه.", "🚩 Reported. Thank you, we will review it.") : L(lang, "مش لاقي البحث ده.", "That search was not found.")}</p>
<p><a class="btn secondary" href="/app/search">${L(lang, "بحث جديد", "New search")}</a></p>`
    }, ok ? 200 : 404);
  });

  // Voice search: the browser sends a note; the AI writes it down (counted against the agency's voice allowance), then
  // the page searches that text as if it were typed. The phone's own speech is the fallback on the page.
  web.post("/search/voice", uploads([VOICE]), async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const voice = req.files && req.files.voice && req.files.voice[0];
    if (!voice) return res.status(400).json({ error: L(lang, "سجّل الأول.", "Record first.") });
    const gate = await RateLimit.hit(pool, `search:broker:${broker.id}`, RateLimit.LIMITS.searchBroker);
    if (!gate.allowed) return res.status(429).json({ error: L(lang, "بحث كتير في دقيقة. استنى شوية.", "Too many searches in a minute. Wait a moment.") });
    try {
      const heard = String(await AI.transcribeAudio(voice.buffer, voice.mimetype.split(";")[0], searchCtx(req)) || "").trim();
      // A search is a few words. A long transcript from silence is the model making up speech, so it is not used.
      const text = heard.length > MAX_SPOKEN_SEARCH ? "" : heard.slice(0, 500);
      if (!text) return res.status(422).json({ error: L(lang, "مسمعناش كويس. جرب تاني.", "Couldn't hear you. Try again.") });
      return res.json({ q: text });
    } catch (err) {
      const why = AiBlock.kindOf(err);
      if (why !== "ai") return res.status(402).json({ error: `${AiBlock.text(why, lang, { owner: isAgencyOwner(broker) })} ${L(lang, "اضغط المايك تاني عشان صوت التليفون.", "Tap the mic again to use the phone's voice.")}`, fallback: true });
      return res.status(503).json({ error: L(lang, "الذكاء الاصطناعي مش متاح دلوقتي.", "The AI is unavailable right now."), fallback: true });
    }
  });

  /* Saved searches (per broker, agency-scoped). */

  web.post("/searches", async (req, res) => {
    const out = await Saved.save(pool, req.session.broker, { token: req.body.f, name: req.body.name });
    if (out.error === "invalid") return res.status(400).send("A name and a valid search are required");
    if (out.error === "limit") return res.status(409).send(`At most ${MAX_SAVED} saved searches`);
    return res.redirect(303, "/app/searches");
  });

  web.get("/searches", async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const items = (await Saved.list(pool, broker)).map((x) => ({ s: x, filters: x.filters, total: x.total, fresh: x.fresh }));
    return page(req, res, {
      title: L(lang, "البحث المحفوظ", "Saved searches"),
      nav: "search",
      body: html`<h1>⭐ ${L(lang, "البحث المحفوظ", "Saved searches")}</h1>
${items.length
  ? html`<ul class="results">${items.map(
      ({ s, filters, total, fresh }) => html`<li class="card row" data-saved="${s.id}">
  <a href="/app/searches/${s.id}"><strong>${s.name}</strong></a>
  <span class="muted">${stripStars(formatInterpretation({ filters }, lang))}</span>
  <span>${L(lang, `${total} وحدة`, `${total} unit(s)`)}</span>
  ${fresh ? html`<span class="ok" data-new="${fresh}">🆕 ${L(lang, `${fresh} جديد`, `${fresh} new`)}</span>` : ""}
  <form method="post" action="/app/searches/${s.id}/delete" data-confirm="${L(lang, "متأكد؟ مش هينفع ترجع.", "Are you sure? This can't be undone.")}"><button class="link" type="submit">${L(lang, "حذف", "Delete")}</button></form>
</li>`
    )}</ul>`
  : html`<p class="card">${L(lang, "مفيش بحث محفوظ لسه. ابحث واضغط «احفظ البحث».", "No saved searches yet. Search, then tap Save search.")}</p>`}`
    });
  });

  web.get("/searches/:id", async (req, res, next) => {
    const lang = langOf(req);
    const { broker } = req.session;
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return next();
    const saved = await Saved.get(pool, broker, req.params.id);
    if (!saved) return next();
    const rows = [saved];
    const filters = saved.filters;
    const out = await runFilters(pool, broker.agency_id, filters, 1);
    await Saved.markSeen(pool, saved.id, out.ids);
    const token = SearchLink.encodeFilters(filters);
    return page(req, res, {
      title: rows[0].name,
      nav: "search",
      body: html`<h1>⭐ ${rows[0].name}</h1>${resultsSection({ res: out, filters, token, page: 1, lang, savedId: rows[0].id })}${refineForm(filters, lang)}`
    });
  });

  web.post("/searches/:id/delete", async (req, res) => {
    await Saved.remove(pool, req.session.broker, req.params.id);
    return res.redirect(303, "/app/searches");
  });
}

module.exports = { WEB_PAGE_SIZE, MAX_SAVED, register };
