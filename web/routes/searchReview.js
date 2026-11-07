// web/routes/searchReview.js — The CRM owner's search review (/app/owner/searches): figures for a period (Yesterday · 7 days ·
// Month), then a work queue: new words the AI proposed, "Wrong search" reports, the nightly findings and the searches that keep
// failing. Filters, paging and an action on every row.
"use strict";

const Dash = require("../../services/dashboards");
const Learn = require("../../services/searchLearn");
const Review = require("../../services/searchReview");
const Vocab = require("../../services/searchVocab");
const Period = require("../../lib/period");
const { html, raw } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const short = (v) => (v ? JSON.stringify(v).replace(/"[a-z_]+":(null|\[\]|""),?/g, "").slice(0, 400) : "—");
const VIEWS = ["queue", "vocab", "cases"];
// The old five tabs were merged into three; their links still work.
const LEGACY = { words: "vocab", reports: "queue", audit: "queue", repeat: "queue" };
const KIND_LABELS = (lang) => [["type", L(lang, "نوع وحدة", "Unit type")], ["feature", L(lang, "ميزة", "Feature")], ["place", L(lang, "كمبوند / منطقة", "Compound or area")], ["furnishing", L(lang, "تفريش", "Furnishing")], ["finishing", L(lang, "تشطيب", "Finishing")], ["listing_type", L(lang, "بيع / إيجار", "Sale or rent")]];
const STATUSES = ["open", "done", "all"];
const pct = (n, of) => (of ? `${Math.round((n / of) * 100)}%` : "—");
const PATH = "/app/owner/searches";

function register(web, { pool, page }) {
  const guard = (req, res, next) => (Dash.isOwner(req.session.broker) ? next() : res.status(404).send("Not found"));
  /** Where an action sends the owner back to: this page with the same filters (never anywhere else). */
  const back = (v) => (typeof v === "string" && v.startsWith(`${PATH}`) && !v.startsWith("//") ? v : PATH);

  web.get("/owner/searches", guard, async (req, res) => {
    const lang = langOf(req);
    const q = req.query;
    const p = Period.parse(q.period);
    const view = VIEWS.includes(q.view) ? q.view : LEGACY[q.view] || "queue";
    const status = STATUSES.includes(q.status) ? q.status : "open";
    const type = Object.keys(Review.TYPES).includes(q.type) ? q.type : "";
    const text = String(q.q || "").trim().slice(0, 80);
    const changed = q.changed === "1";
    const params = { period: p.key, view, status: status === "open" ? "" : status, type, q: text, changed: changed ? "1" : "" };
    const noteKey = String(q.note || "").slice(0, 40);
    const noteText = String(q.why || "").slice(0, 400);
    const pg = Period.pageOf(q.page);
    const win = Review.windowOf(p, changed);
    const sum = await Review.summary(pool, p);
    const csrf = req.session.csrf;
    const here = `${PATH}${Period.qs(params, { page: pg.page > 1 ? pg.page : "" })}`;
    const form = (action, fields, label, cls = "") =>
      html`<form method="post" action="${action}" class="row"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="back" value="${here}">${raw(Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, "&quot;")}">`).join(""))}<button class="${cls}">${label}</button></form>`;

    let content;
    let total = 0;
    const NOTES = {
      saved: [L(lang, "اتحفظت الكلمة وهتتطبق على البحث الجاي.", "Word saved; the next search uses it."), ""],
      preview: [L(lang, "معاينة بس (مفيش حاجة اتحفظت)", "Preview only (nothing saved)"), ""],
      blocked: [L(lang, "اتمنعت: الكلمة دي هتكسر حالات اختبار شغالة", "Blocked: this word would break passing test cases"), ""],
      invalid: [L(lang, "املأ الكلمة والمعنى والنوع.", "Fill in the word, what it means and its kind."), ""],
      rechecked: [L(lang, "اتأكدنا: البحث اتقرا صح واتقفل.", "Re-check passed: the search reads correctly and was closed."), ""],
      notyet: [L(lang, "لسه فيه مشكلة", "Still a problem"), ""],
      case: [L(lang, "اتضافت كحالة اختبار.", "Added as a test case."), ""],
      bad_json: [L(lang, "الفلاتر المتوقعة لازم تبقى JSON صحيح.", "Expected filters must be valid JSON."), ""]
    };
    const noteBox = NOTES[noteKey] ? html`<p class="card notice${noteKey === "blocked" || noteKey === "notyet" || noteKey === "invalid" || noteKey === "bad_json" ? " bad" : ""}" role="status" data-note="${noteKey}">${NOTES[noteKey][0]}${noteText ? html` — ${noteText}` : ""}</p>` : "";
    const kindSelect = (cur) => html`<select name="kind">${KIND_LABELS(lang).map(([k, label]) => html`<option value="${k}"${k === cur ? raw(" selected") : ""}>${label}</option>`)}</select>`;
    if (view === "vocab") {
      const r = await Review.vocabulary(pool, { q: text, offset: pg.offset, limit: pg.size });
      total = r.total;
      content = r.rows.length
        ? html`<table><thead><tr><th>${L(lang, "تعديل", "Edit")}</th><th>${L(lang, "الحالة", "Status")}</th><th>${L(lang, "مثال", "Example")}</th><th>${L(lang, "قرار", "Decide")}</th></tr></thead><tbody>
${r.rows.map((w) => html`<tr data-alias="${w.id}" data-status="${w.status}"><td><form method="post" action="${PATH}/words/${w.id}" class="stack" data-edit-word><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="back" value="${here}">
<label>${L(lang, "الكلمة (الإملا الصح)", "Word (correct spelling)")}<input name="term" value="${w.term}" required></label>
<label>${L(lang, "النوع", "Kind")}${kindSelect(w.kind)}</label>
<label>${L(lang, "تعني (الاسم الصح)", "Means (correct name)")}<input name="target" value="${w.target}" required></label>
<button name="decision" value="save" class="secondary">${L(lang, "احفظ التعديل", "Save changes")}</button></form></td>
<td>${w.status === "pending" ? L(lang, `مقترحة · الذكاء اتفق ${w.agreed} مرة`, `Proposed · AI agreed ${w.agreed}×`) : L(lang, "معتمدة", "Approved")}</td><td class="muted">${w.example || ""}</td>
<td><form method="post" action="${PATH}/words/${w.id}" class="stack"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="back" value="${here}">${w.status === "pending" ? html`<button name="decision" value="approve">${L(lang, "اعتمد", "Approve")}</button> <button name="decision" value="reject" class="secondary">${L(lang, "ارفض", "Reject")}</button>` : html`<button name="decision" value="remove" class="secondary" data-confirm="${L(lang, "تمسح الكلمة دي؟", "Remove this word?")}">${L(lang, "امسحها", "Remove")}</button>`}</form></td></tr>`)}</tbody></table>`
        : html`<p class="muted">${L(lang, "مفيش كلمات.", "No words.")}</p>`;
    } else if (view === "cases") {
      const r = await Review.casesWithResults(pool, { q: text, offset: pg.offset, limit: pg.size });
      total = r.total;
      content = r.rows.length
        ? html`<p class="muted small" data-failing="${r.failing}">${L(lang, `${r.failing} حالة بتفشل دلوقتي`, `${r.failing} case(s) failing now`)}</p><table><thead><tr><th>${L(lang, "البحث", "Search")}</th><th>${L(lang, "النتيجة", "Result")}</th><th>${L(lang, "المتوقع", "Expected")}</th><th>${L(lang, "اتضاف", "Added")}</th><th></th></tr></thead><tbody>
${r.rows.map((x) => html`<tr data-case="${x.id}" data-pass="${x.pass ? "1" : "0"}"><td>${x.query_text}${x.note ? html`<br><span class="muted small">${x.note}</span>` : ""}</td><td>${x.pass ? "✅" : "❌"}${x.pass ? "" : html` <code dir="ltr" class="small">${short(x.got)}</code>`}</td><td>${x.expected ? html`<code dir="ltr" class="small">${short(x.expected)}</code> <span class="badge">${L(lang, "مشكلة قاعدة", "rule problem")}</span>` : html`<span class="muted small">${L(lang, "تتقرا من غير أسئلة", "reads with no open question")}</span>`}</td><td class="muted">${new Date(x.created_at).toISOString().slice(0, 10)}</td><td>${form(`${PATH}/cases/${x.id}`, { decision: "remove" }, L(lang, "امسحه", "Remove"), "secondary")}</td></tr>`)}</tbody></table>`
        : html`<p class="muted">${L(lang, "مفيش حالات اختبار لسه. ضيف من الطابور.", "No test cases yet. Add them from the queue.")}</p>`;
    } else {
      const r = await Review.queue(pool, { ...win, status, type, q: text, offset: pg.offset, limit: pg.size });
      total = r.total;
      content = r.rows.length
        ? html`${r.rows.map((x) => html`<div class="card stack" data-queue-row="${x.query_text}" data-open="${x.open_n}">
<p><strong>${x.query_text}</strong> <span class="muted small">${x.reports ? html`<span class="badge" data-src="report">${L(lang, `بلاغ ×${x.reports}`, `report ×${x.reports}`)}</span> ` : ""}${x.findings ? html`<span class="badge" data-src="audit">${L(lang, `فحص الليل ×${x.findings}`, `nightly ×${x.findings}`)}</span> ` : ""}${x.reports + x.findings > 2 ? html`<span class="badge" data-src="repeat">${L(lang, `اتكرر ${x.reports + x.findings} مرات`, `seen ${x.reports + x.findings}×`)}</span> ` : ""}· ${L(lang, "نتايج", "results")}: ${x.total}${x.open_n ? "" : ` · ${L(lang, "اتقفل", "closed")}`}</span></p>
<details><summary class="muted small">${L(lang, "افتح وصلّح", "Open and fix")}</summary>
<form method="post" action="${PATH}/teach" class="stack" data-teach><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="back" value="${here}"><input type="hidden" name="text" value="${x.query_text}">
<label>${L(lang, "الكلمة اللي السمسار كتبها", "Word the broker used")}<input name="term" required></label>
<label>${L(lang, "النوع", "Kind")}${kindSelect("place")}</label>
<label>${L(lang, "تعني (الاسم الصح)", "Means (correct name)")}<input name="target" required></label>
<div class="row"><button name="decision" value="preview" class="secondary">${L(lang, "معاينة التأثير", "Preview impact")}</button> <button name="decision" value="save">${L(lang, "علّم الكلمة", "Teach word")}</button></div></form>
<form method="post" action="${PATH}/queue/case" class="stack" data-rule><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="back" value="${here}"><input type="hidden" name="text" value="${x.query_text}">
<label>${L(lang, "الفلاتر المتوقعة (JSON) — لو المشكلة في القاعدة", "Expected filters (JSON) — for a rule problem")}<input name="expected" dir="ltr" placeholder='{"price_max":2500}'></label>
<button class="secondary">${L(lang, "ضيفه كحالة اختبار", "Add as test case")}</button></form></details>
<div class="row">${form(`${PATH}/queue/recheck`, { text: x.query_text }, L(lang, "أعد الفحص", "Re-check"))} ${form(`${PATH}/queue/dismiss`, { text: x.query_text }, L(lang, "تجاهل", "Dismiss"), "secondary")}</div></div>`)}`
        : html`<p class="muted">${L(lang, "الطابور فاضي في الفترة دي.", "The queue is empty for this period.")}</p>`;
    }

    const tab = (v, ar, en, n) => html`<a href="${PATH}${Period.qs(params, { view: v, page: "", status: v === "vocab" ? "" : params.status })}"${v === view ? raw(' aria-current="page"') : ""} data-view="${v}">${L(lang, ar, en)}${n ? ` (${n})` : ""}</a>`;
    const card = (ar, en, value, delta) => html`<div class="card" data-figure><span class="muted">${L(lang, ar, en)}</span><strong>${value}</strong>${delta ? html` <span class="muted small">${delta}</span>` : ""}</div>`;
    const n = sum.now;
    const b = sum.before;
    const last = sum.lastChecked ? new Date(sum.lastChecked).toISOString().replace("T", " ").slice(0, 16) + " UTC" : L(lang, "لسه ماشتغلش", "not yet");
    return page(req, res, {
      title: L(lang, "مراجعة البحث", "Search review"),
      nav: "owner",
      body: html`<h1>🔎 ${L(lang, "مراجعة البحث", "Search review")}</h1>
<details class="card" data-howto${total === 0 && !text ? raw(" open") : ""}><summary>${L(lang, "إزاي أستخدمها؟", "How to use this page")}</summary>
<p>${L(lang, "الأرقام فوق بتقول البحث ماشي كويس ولا لأ. ", "The figures show how search is doing. ")}<strong>${L(lang, "الطابور", "Queue")}</strong> ${L(lang, "فيه كل بحث فيه مشكلة (بلاغ من سمسار، فحص الليل، أو متكرر) مرة واحدة: افتحه وعلّم الكلمة (بنعرض الأثر قبل الحفظ) أو ضيفه كحالة اختبار لو القاعدة غلط، وبعدين «أعد الفحص». ", "has every problem search once (a broker report, the nightly check, or a repeat): open it and teach a word (the impact is shown before saving), or keep it as a test case when the rule is wrong, then Re-check. ")}<strong>${L(lang, "الكلمات", "Vocabulary")}</strong> ${L(lang, "كلمات الذكاء المقترحة والمعتمدة. ", "holds the words the AI proposed and the approved ones. ")}<strong>${L(lang, "حالات الاختبار", "Test cases")}</strong> ${L(lang, "بتتشغل كل مرة وبتبين نجحت ولا فشلت.", "run every time and show pass or fail.")}</p></details>
${Period.tabs(PATH, params, p.key, lang)}
<p class="muted small" data-last-checked>${L(lang, "آخر فحص ليل لحد", "Nightly check data up to")}: ${last}</p>
<div class="grid" data-summary>
${card("بحث", "Searches", n.searches, Period.change(n.searches, b.searches))}
${card("بدون نتايج", "Zero results", pct(n.zero, n.searches), `${n.zero} · ${Period.change(n.zero, b.zero)}`)}
${card("بلاغات «بحث غلط»", "\"Wrong search\" reports", n.reports, Period.change(n.reports, b.reports))}
${card("ملاحظات فحص الليل", "Nightly problems", pct(n.flagged, n.searches), `${n.flagged} · ${Period.change(n.flagged, b.flagged)}`)}
</div>
<nav class="seg" data-queue>${tab("queue", "الطابور", "Queue", sum.open.reports + sum.open.audit)}${tab("vocab", "الكلمات", "Vocabulary", sum.open.words)}${tab("cases", "حالات الاختبار", "Test cases", 0)}</nav>${noteBox}
${view === "vocab" ? "" : html`<form method="get" action="${PATH}" class="row" data-filters>
<input type="hidden" name="period" value="${p.key}"><input type="hidden" name="view" value="${view}">
<input type="search" name="q" value="${text}" placeholder="${L(lang, "دوّر في البحث", "Search text")}">
${view === "cases" ? "" : html`<select name="status"><option value="open"${status === "open" ? raw(" selected") : ""}>${L(lang, "مفتوح", "Open")}</option><option value="done"${status === "done" ? raw(" selected") : ""}>${L(lang, "اتقفل", "Done")}</option><option value="all"${status === "all" ? raw(" selected") : ""}>${L(lang, "الكل", "All")}</option></select>`}
${view === "queue" ? html`<select name="type"><option value="">${L(lang, "كل الأنواع", "All types")}</option>${Object.keys(Review.TYPES).map((t) => html`<option value="${t}"${t === type ? raw(" selected") : ""}>${t}</option>`)}</select>` : ""}
<label class="row"><input type="checkbox" name="changed" value="1"${changed ? raw(" checked") : ""}> ${L(lang, "اتغير آخر يوم", "Changed in the last day")}</label>
<button class="secondary">${L(lang, "فلتر", "Filter")}</button></form>`}
<section class="card stack" data-view-body="${view}">${content}</section>
${Period.pager(PATH, params, pg, total, lang)}`
    });
  });

  web.post("/owner/searches/words/:id", guard, async (req, res) => {
    if (req.body.decision === "save") await Review.editWord(pool, req.params.id, { term: req.body.term, kind: req.body.kind, target: req.body.target }, { statuses: ["pending", "approved"] });
    else if (req.body.decision === "remove") await Review.removeWord(pool, req.params.id);
    else await Learn.decide(pool, req.params.id, req.body.decision === "approve");
    await Vocab.refresh(pool); // the parser uses the change from the next search
    return res.redirect(303, back(req.body.back));
  });
  web.post("/owner/searches/reports/:id", guard, async (req, res) => {
    if (/^[0-9a-f-]{36}$/i.test(req.params.id)) await Review.decideReport(pool, req.params.id, req.body.decision);
    return res.redirect(303, back(req.body.back));
  });
  web.post("/owner/searches/audit/:id", guard, async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.redirect(303, back(req.body.back));
    if (req.body.decision === "addcase") await Review.addCase(pool, req.params.id, req.session.broker.id);
    else await Review.decideFinding(pool, req.params.id, req.body.decision);
    return res.redirect(303, back(req.body.back));
  });
  web.post("/owner/searches/cases/:id", guard, async (req, res) => {
    if (/^[0-9a-f-]{36}$/i.test(req.params.id) && req.body.decision === "remove") await Review.removeCase(pool, req.params.id);
    return res.redirect(303, back(req.body.back));
  });
  /** Redirects back with a short note (never anything but this page). */
  const noted = (req, res, note, why = "") => {
    const b = back(req.body.back);
    return res.redirect(303, `${b}${b.includes("?") ? "&" : "?"}note=${note}${why ? `&why=${encodeURIComponent(why.slice(0, 300))}` : ""}`);
  };
  // Teach a word (or only preview it): the impact on this search and on the kept test cases is checked first; a word that would
  // break a passing test case is not saved.
  web.post("/owner/searches/teach", guard, async (req, res) => {
    const input = { term: req.body.term, kind: req.body.kind, target: req.body.target, text: String(req.body.text || "").slice(0, 300) };
    if (req.body.decision === "preview") {
      const pre = await Review.previewWord(pool, input);
      if (pre.error) return noted(req, res, "invalid");
      const why = [pre.reading_changes ? "reading changes" : "reading unchanged", `fixes ${pre.fixes.length} case(s)`, pre.breaks.length ? `breaks: ${pre.breaks.join(", ")}` : "breaks none"].join("; ");
      return noted(req, res, "preview", why);
    }
    const r = await Review.teachWord(pool, input);
    if (r.error) return noted(req, res, "invalid");
    if (r.blocked) return noted(req, res, "blocked", r.blocked.join(", "));
    await Vocab.refresh(pool);
    return noted(req, res, "saved");
  });
  web.post("/owner/searches/queue/case", guard, async (req, res) => {
    const r = await Review.addTextCase(pool, req.body.text, { expected: req.body.expected || null, ownerId: req.session.broker.id });
    return noted(req, res, r.error === "bad_json" ? "bad_json" : r.error ? "invalid" : "case");
  });
  // Re-check: a search text is closed only when it has a test case that passes and the quick reader has no open question.
  web.post("/owner/searches/queue/recheck", guard, async (req, res) => {
    const text = String(req.body.text || "").slice(0, 300);
    if (!text) return noted(req, res, "invalid");
    const gate = await Review.recheck(pool, text);
    if (!gate.ok) return noted(req, res, "notyet", `missing: ${gate.missing.join(", ")}`);
    await Review.closeText(pool, text, "fixed");
    return noted(req, res, "rechecked");
  });
  web.post("/owner/searches/queue/dismiss", guard, async (req, res) => {
    const text = String(req.body.text || "").slice(0, 300);
    if (text) await Review.closeText(pool, text, "dismiss");
    return res.redirect(303, back(req.body.back));
  });
}

module.exports = { register };
