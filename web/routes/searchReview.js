// web/routes/searchReview.js — The CRM owner's search review (/app/owner/searches): figures for a period (Yesterday · 7 days ·
// Month), then a work queue: new words the AI proposed, "Wrong search" reports, the nightly findings and the searches that keep
// failing. Filters, paging and an action on every row.
"use strict";

const Dash = require("../../services/dashboards");
const Learn = require("../../services/searchLearn");
const Review = require("../../services/searchReview");
const Period = require("../../lib/period");
const { html, raw } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const short = (v) => (v ? JSON.stringify(v).replace(/"[a-z_]+":(null|\[\]|""),?/g, "").slice(0, 400) : "—");
const VIEWS = ["words", "reports", "audit", "repeat", "cases"];
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
    const view = VIEWS.includes(q.view) ? q.view : "reports";
    const status = STATUSES.includes(q.status) ? q.status : "open";
    const type = Object.keys(Review.TYPES).includes(q.type) ? q.type : "";
    const text = String(q.q || "").trim().slice(0, 80);
    const changed = q.changed === "1";
    const params = { period: p.key, view, status: status === "open" ? "" : status, type, q: text, changed: changed ? "1" : "" };
    const pg = Period.pageOf(q.page);
    const win = Review.windowOf(p, changed);
    const sum = await Review.summary(pool, p);
    const csrf = req.session.csrf;
    const here = `${PATH}${Period.qs(params, { page: pg.page > 1 ? pg.page : "" })}`;
    const form = (action, fields, label, cls = "") =>
      html`<form method="post" action="${action}" class="row"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="back" value="${here}">${raw(Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, "&quot;")}">`).join(""))}<button class="${cls}">${label}</button></form>`;

    let content;
    let total = 0;
    if (view === "words") {
      const all = await Learn.pending(pool);
      total = all.length;
      const words = all.slice(pg.offset, pg.offset + pg.size);
      content = words.length
        ? html`<table><thead><tr><th>${L(lang, "الكلمة", "Word")}</th><th>${L(lang, "تعني", "Means")}</th><th>${L(lang, "اتفاق الذكاء", "AI agreed")}</th><th>${L(lang, "مثال", "Example")}</th><th></th></tr></thead><tbody>
${words.map((w) => html`<tr data-alias="${w.id}"><td>${w.term}</td><td>${w.target} <span class="muted">(${w.kind})</span></td><td>${w.agreed}</td><td class="muted">${w.example || ""}</td>
<td><form method="post" action="${PATH}/words/${w.id}" class="row"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="back" value="${here}"><button name="decision" value="approve">${L(lang, "اعتمد", "Approve")}</button> <button name="decision" value="reject" class="secondary">${L(lang, "ارفض", "Reject")}</button></form></td></tr>`)}</tbody></table>`
        : html`<p class="muted">${L(lang, "مفيش كلمات مقترحة.", "Nothing proposed.")}</p>`;
    } else if (view === "reports") {
      const r = await Review.reports(pool, { ...win, status, q: text, offset: pg.offset, limit: pg.size });
      total = r.total;
      content = r.rows.length
        ? r.rows.map((x) => html`<div class="card" data-report="${x.id}"><strong>${x.query_text || "—"}</strong> <span class="muted">(${x.source}, ${x.total})${x.status !== "open" ? ` · ${x.status}` : ""}</span>${x.note ? html`<p>${x.note}</p>` : ""}
<p class="muted">${L(lang, "القارئ السريع", "Quick reader")}: <code dir="ltr">${short(x.local_filters)}</code></p>
<p class="muted">${L(lang, "الذكاء", "AI")}: <code dir="ltr">${short(x.ai_filters)}</code></p>
<p class="muted">${L(lang, "اللي اتبحث بيه", "Used")}: <code dir="ltr">${short(x.used_filters)}</code></p>
<div class="row">${x.status === "open" ? html`${form(`${PATH}/reports/${x.id}`, { decision: "fixed" }, L(lang, "اتصلح", "Fixed"))} ${form(`${PATH}/reports/${x.id}`, { decision: "dismiss" }, L(lang, "تجاهل", "Ignore"), "secondary")}` : form(`${PATH}/reports/${x.id}`, { decision: "reopen" }, L(lang, "افتحه تاني", "Reopen"), "secondary")}</div></div>`)
        : html`<p class="muted">${L(lang, "مفيش بلاغات في الفترة دي.", "No reports in this period.")}</p>`;
    } else if (view === "audit") {
      const r = await Review.findings(pool, { ...win, status, type, q: text, offset: pg.offset, limit: pg.size });
      total = r.total;
      const finding = (a) =>
        [a.zero ? L(lang, "صفر نتايج", "zero results") : "", a.bad_ids?.length ? L(lang, `${a.bad_ids.length} نتيجة غلط`, `${a.bad_ids.length} wrong results`) : "", a.disagree?.length ? L(lang, `اختلاف: ${a.disagree.join("، ")}`, `differ: ${a.disagree.join(", ")}`) : "", a.missed_ids?.length ? L(lang, `${a.missed_ids.length} وحدة فاتت`, `${a.missed_ids.length} missed units`) : ""].filter(Boolean).join(" · ");
      content = r.rows.length
        ? html`<table><thead><tr><th>${L(lang, "البحث", "Search")}</th><th>${L(lang, "النتايج", "Results")}</th><th>${L(lang, "الملاحظة", "Finding")}</th><th></th></tr></thead><tbody>
${r.rows.map((a) => html`<tr data-finding="${a.id}"><td>${a.query_text || "—"}</td><td>${a.total}</td><td>${finding(a.audit)}</td><td>${a.audit_resolved_at ? form(`${PATH}/audit/${a.id}`, { decision: "reopen" }, L(lang, "افتحه تاني", "Reopen"), "secondary") : form(`${PATH}/audit/${a.id}`, { decision: "resolve" }, L(lang, "اتعالج", "Handled"))} ${form(`${PATH}/audit/${a.id}`, { decision: "addcase" }, L(lang, "ضيفه كحالة اختبار", "Add as test case"), "secondary")}</td></tr>`)}</tbody></table>`
        : html`<p class="muted">${L(lang, "مفيش ملاحظات في الفترة دي.", "Nothing found in this period.")}</p>`;
    } else if (view === "cases") {
      const r = await Review.cases(pool, { q: text, offset: pg.offset, limit: pg.size });
      total = r.total;
      content = r.rows.length
        ? html`<table><thead><tr><th>${L(lang, "البحث", "Search")}</th><th>${L(lang, "اتضاف", "Added")}</th><th></th></tr></thead><tbody>
${r.rows.map((x) => html`<tr data-case="${x.id}"><td>${x.query_text}</td><td class="muted">${new Date(x.created_at).toISOString().slice(0, 10)}</td><td>${form(`${PATH}/cases/${x.id}`, { decision: "remove" }, L(lang, "امسحه", "Remove"), "secondary")}</td></tr>`)}</tbody></table>`
        : html`<p class="muted">${L(lang, "مفيش حالات اختبار لسه. ضيف من فحص الليل.", "No test cases yet. Add them from the nightly check.")}</p>`;
    } else {
      const r = await Review.repeats(pool, { ...win, q: text, offset: pg.offset, limit: pg.size });
      total = r.total;
      content = r.rows.length
        ? html`<table><thead><tr><th>${L(lang, "البحث", "Search")}</th><th>${L(lang, "مرات", "Times")}</th><th></th></tr></thead><tbody>
${r.rows.map((x) => html`<tr data-repeat><td>${x.query_text}</td><td>${x.times}</td><td>${form(`${PATH}/repeat`, { text: x.query_text }, L(lang, "اتعالج كله", "All handled"))}</td></tr>`)}</tbody></table>`
        : html`<p class="muted">${L(lang, "مفيش بحث اتكرر فشله.", "No search keeps failing.")}</p>`;
    }

    const tab = (v, ar, en, n) => html`<a href="${PATH}${Period.qs(params, { view: v, page: "", status: v === "words" ? "" : params.status })}"${v === view ? raw(' aria-current="page"') : ""} data-view="${v}">${L(lang, ar, en)}${n ? ` (${n})` : ""}</a>`;
    const card = (ar, en, value, delta) => html`<div class="card" data-figure><span class="muted">${L(lang, ar, en)}</span><strong>${value}</strong>${delta ? html` <span class="muted small">${delta}</span>` : ""}</div>`;
    const n = sum.now;
    const b = sum.before;
    const last = sum.lastChecked ? new Date(sum.lastChecked).toISOString().replace("T", " ").slice(0, 16) + " UTC" : L(lang, "لسه ماشتغلش", "not yet");
    return page(req, res, {
      title: L(lang, "مراجعة البحث", "Search review"),
      nav: "owner",
      body: html`<h1>🔎 ${L(lang, "مراجعة البحث", "Search review")}</h1>
<details class="card" data-howto${total === 0 && !text ? raw(" open") : ""}><summary>${L(lang, "إزاي أستخدمها؟", "How to use this page")}</summary>
<p>${L(lang, "الأرقام فوق بتقول البحث ماشي كويس ولا لأ. تحتها قايمة شغل: ", "The figures show how search is doing. Below is a work queue: ")}<strong>${L(lang, "كلمات جديدة", "New words")}</strong> ${L(lang, "اعتمدها أو ارفضها، ", "approve or reject, ")}<strong>${L(lang, "البلاغات", "Reports")}</strong> ${L(lang, "من السماسرة: اتصلح أو تجاهل، ", "from brokers: fixed or ignore, ")}<strong>${L(lang, "فحص الليل", "Nightly check")}</strong> ${L(lang, "(بيشتغل مرة في اليوم بعد ٣ الفجر): اتعالج، ", "(runs once a day after 03:00 Cairo): mark handled, ")}<strong>${L(lang, "المتكرر", "Repeat offenders")}</strong> ${L(lang, "ابدأ بيها.", "start there.")}</p></details>
${Period.tabs(PATH, params, p.key, lang)}
<p class="muted small" data-last-checked>${L(lang, "آخر فحص ليل لحد", "Nightly check data up to")}: ${last}</p>
<div class="grid" data-summary>
${card("بحث", "Searches", n.searches, Period.change(n.searches, b.searches))}
${card("بدون نتايج", "Zero results", pct(n.zero, n.searches), `${n.zero} · ${Period.change(n.zero, b.zero)}`)}
${card("بلاغات «بحث غلط»", "\"Wrong search\" reports", n.reports, Period.change(n.reports, b.reports))}
${card("ملاحظات فحص الليل", "Nightly problems", pct(n.flagged, n.searches), `${n.flagged} · ${Period.change(n.flagged, b.flagged)}`)}
</div>
<nav class="seg" data-queue>${tab("words", "كلمات جديدة", "New words", sum.open.words)}${tab("reports", "بلاغات", "Reports", sum.open.reports)}${tab("audit", "فحص الليل", "Nightly check", sum.open.audit)}${tab("repeat", "متكرر", "Repeat offenders", 0)}${tab("cases", "حالات الاختبار", "Test cases", 0)}</nav>
${view === "words" ? "" : html`<form method="get" action="${PATH}" class="row" data-filters>
<input type="hidden" name="period" value="${p.key}"><input type="hidden" name="view" value="${view}">
<input type="search" name="q" value="${text}" placeholder="${L(lang, "دوّر في البحث", "Search text")}">
${view === "repeat" || view === "cases" ? "" : html`<select name="status"><option value="open"${status === "open" ? raw(" selected") : ""}>${L(lang, "مفتوح", "Open")}</option><option value="done"${status === "done" ? raw(" selected") : ""}>${L(lang, "اتقفل", "Done")}</option><option value="all"${status === "all" ? raw(" selected") : ""}>${L(lang, "الكل", "All")}</option></select>`}
${view === "audit" ? html`<select name="type"><option value="">${L(lang, "كل الأنواع", "All types")}</option>${Object.keys(Review.TYPES).map((t) => html`<option value="${t}"${t === type ? raw(" selected") : ""}>${t}</option>`)}</select>` : ""}
<label class="row"><input type="checkbox" name="changed" value="1"${changed ? raw(" checked") : ""}> ${L(lang, "اتغير آخر يوم", "Changed in the last day")}</label>
<button class="secondary">${L(lang, "فلتر", "Filter")}</button></form>`}
<section class="card stack" data-view-body="${view}">${content}</section>
${Period.pager(PATH, params, pg, total, lang)}`
    });
  });

  web.post("/owner/searches/words/:id", guard, async (req, res) => {
    await Learn.decide(pool, req.params.id, req.body.decision === "approve");
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
  web.post("/owner/searches/repeat", guard, async (req, res) => {
    if (req.body.text) await Review.resolveText(pool, String(req.body.text).slice(0, 300));
    return res.redirect(303, back(req.body.back));
  });
}

module.exports = { register };
