// web/routes/accessRequests.js — Private-details requests (/app/access-requests): every ask from a broker to see a unit's secret
// details, in one list for managers, with the period's figures, filters, paging and approve / decline on each pending row.
"use strict";

const Authz = require("../../lib/authz");
const Queue = require("../../services/accessQueue");
const Period = require("../../lib/period");
const { html, raw } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const PATH = "/app/access-requests";
const STATUS_LABEL = { pending: ["مستني", "Pending"], approved: ["اتوافق", "Approved"], declined: ["اترفض", "Declined"] };
const when = (d) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) : "—");

function register(web, { pool, page }) {
  const guard = (req, res, next) => (Authz.isManager(req.session.broker) ? next() : res.status(404).send("Not found"));
  const back = (v) => (typeof v === "string" && v.startsWith(PATH) && !v.startsWith("//") ? v : PATH);

  web.get("/access-requests", guard, async (req, res) => {
    const lang = langOf(req);
    const broker = req.session.broker;
    const p = Period.parse(req.query.period);
    const status = [...Queue.STATUSES, "all"].includes(req.query.status) ? req.query.status : "pending";
    const text = String(req.query.q || "").trim().slice(0, 60);
    const changed = req.query.changed === "1";
    const params = { period: p.key, status: status === "pending" ? "" : status, q: text, changed: changed ? "1" : "" };
    const pg = Period.pageOf(req.query.page);
    const win = changed ? { from: new Date(Date.now() - 24 * 3600 * 1000), to: new Date() } : { from: p.from, to: p.to };
    const [sum, out] = await Promise.all([Queue.summary(pool, broker, p), Queue.list(pool, broker, { ...win, status, q: text, offset: pg.offset, limit: pg.size })]);
    const here = `${PATH}${Period.qs(params, { page: pg.page > 1 ? pg.page : "" })}`;
    const act = (id, decision, label, cls = "") =>
      html`<form method="post" action="${PATH}/${id}" class="row"><input type="hidden" name="_csrf" value="${req.session.csrf}"><input type="hidden" name="back" value="${here}"><button name="decision" value="${decision}" class="${cls}">${label}</button></form>`;
    const card = (ar, en, value, delta) => html`<div class="card" data-figure><span class="muted">${L(lang, ar, en)}</span><strong>${value}</strong>${delta ? html` <span class="muted small">${delta}</span>` : ""}</div>`;
    const n = sum.cur;
    const b = sum.prev;
    const tab = (s, ar, en) => html`<a href="${PATH}${Period.qs(params, { status: s === "pending" ? "" : s, page: "" })}"${s === status ? raw(' aria-current="page"') : ""} data-status="${s}">${L(lang, ar, en)}${s === "pending" && sum.pending ? ` (${sum.pending})` : ""}</a>`;
    return page(req, res, {
      title: L(lang, "طلبات البيانات الخاصة", "Private data requests"),
      nav: "links",
      body: html`<h1>🔒 ${L(lang, "طلبات البيانات الخاصة", "Private data requests")}</h1>
<details class="card" data-howto><summary>${L(lang, "إزاي أستخدمها؟", "How to use this page")}</summary>
<p>${L(lang, "ده كل طلبات البروكرز لرؤية بيانات وحدة خاصة (المالك والعنوان واللوكيشن). وافق أو ارفض من هنا، والسمسار بيتبلّغ. الموافقة بتفضل ٣٠ يوم.", "Every broker request to see a unit's private details (owner, address, pin). Approve or decline here and the broker is told. An approval lasts 30 days.")}</p>
${sum.canAnswer ? "" : html`<p class="muted">${L(lang, "الرد على الطلبات للمديرين؛ صاحب الشركة بيرد لو مفيش مدير.", "Managers answer requests; the agency owner answers only when there is no manager.")}</p>`}</details>
${Period.tabs(PATH, params, p.key, lang)}
<div class="grid" data-summary>
${card("طلبات", "Asked", n.asked, Period.change(n.asked, b.asked))}
${card("اتوافق", "Approved", n.approved, Period.change(n.approved, b.approved))}
${card("اترفض", "Declined", n.declined, Period.change(n.declined, b.declined))}
${card("متوسط وقت الرد (ساعة)", "Average answer time (h)", n.hours ?? "—", "")}
${card("مستني دلوقتي", "Waiting now", sum.pending, sum.oldestHours != null ? L(lang, `الأقدم من ${sum.oldestHours} ساعة`, `oldest ${sum.oldestHours} h`) : "")}
</div>
<nav class="seg" data-queue>${tab("pending", "مستني", "Pending")}${tab("approved", "اتوافق", "Approved")}${tab("declined", "اترفض", "Declined")}${tab("all", "الكل", "All")}</nav>
<form method="get" action="${PATH}" class="row" data-filters><input type="hidden" name="period" value="${p.key}"><input type="hidden" name="status" value="${status === "pending" ? "" : status}">
<input type="search" name="q" value="${text}" placeholder="${L(lang, "كود الوحدة أو اسم السمسار", "Unit code or broker")}">
<label class="row"><input type="checkbox" name="changed" value="1"${changed ? raw(" checked") : ""}> ${L(lang, "اتغير آخر يوم", "Changed in the last day")}</label>
<button class="secondary">${L(lang, "فلتر", "Filter")}</button></form>
<section class="card stack" data-requests>${out.rows.length
        ? html`<table><thead><tr><th>${L(lang, "الوحدة", "Unit")}</th><th>${L(lang, "السمسار", "Broker")}</th><th>${L(lang, "الحالة", "Status")}</th><th>${L(lang, "إمتى", "When")}</th><th></th></tr></thead><tbody>
${out.rows.map((r) => html`<tr data-request="${r.id}"><td><a href="/app/units/${encodeURIComponent(r.code)}#access">${r.code}</a></td><td>${r.broker_name}</td><td>${L(lang, STATUS_LABEL[r.status][0], STATUS_LABEL[r.status][1])}${r.decided_by_name ? html` <span class="muted small">${r.decided_by_name}</span>` : ""}</td><td class="muted">${when(r.created_at)}</td>
<td>${r.status === "pending" && sum.canAnswer ? html`${act(r.id, "approve", L(lang, "وافق", "Approve"))} ${act(r.id, "decline", L(lang, "ارفض", "Decline"), "secondary")}` : ""}</td></tr>`)}</tbody></table>`
        : html`<p class="muted">${L(lang, "مفيش طلبات هنا.", "No requests here.")}</p>`}</section>
${Period.pager(PATH, params, pg, out.total, lang)}`
    });
  });

  web.post("/access-requests/:id", guard, async (req, res) => {
    const id = /^\d{1,12}$/.test(req.params.id) ? Number(req.params.id) : null;
    if (id && ["approve", "decline"].includes(req.body.decision)) await Queue.answer(pool, req.session.broker, id, req.body.decision === "approve");
    return res.redirect(303, back(req.body.back));
  });
}

module.exports = { register };
