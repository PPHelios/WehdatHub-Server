// web/routes/requests.js — Client requests: every request (a saved search with alerts, tied to a lead or not) in
// Pending and Fulfilled tabs. Add one (a description, optionally linked to a lead by code or phone), mark it
// fulfilled, delete it. Same service as the app (services/clientRequests.js).
"use strict";

const Requests = require("../../services/clientRequests");
const Card = require("../../domain/leadCard");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const day = (d) => new Date(d).toISOString().slice(0, 10);

const ERRORS = {
  invalid: ["اكتب وصف الطلب (مثلاً: شقة ٣ غرف في التجمع لحد ٥ مليون).", "Describe the request (for example: 3-bedroom apartment in New Cairo up to 5 million)."],
  lead_not_found: ["مفيش عميل بالكود أو الرقم ده.", "No client with that code or number."],
  too_many_requests: ["العميل ده عنده ٣ طلبات مفتوحة، الحد الأقصى.", "This client already has 3 open requests, the maximum."],
  too_many_requests_broker: ["عندك ٣٠ طلب مفتوح، الحد الأقصى. امسح طلب قديم الأول.", "You have 30 open requests, the maximum. Remove an old one first."],
  forbidden: ["مش مسموح لك تضيف طلب للعميل ده.", "You can't add a request to this client."]
};

function register(web, { pool, page }) {
  web.get("/requests", async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const tab = req.query.tab === "fulfilled" ? "fulfilled" : "pending";
    const out = await Requests.list(pool, broker, { tab, page: req.query.page });
    const err = ERRORS[String(req.query.error || "")];
    const csrf = req.session.csrf;
    const link = (t, p = 1) => `/app/requests?tab=${t}${p > 1 ? `&page=${p}` : ""}`;
    const summary = (it) => Card.requestSummary(it.filters, lang) || "—";
    return page(req, res, {
      title: L(lang, "طلبات العملاء", "Client requests"),
      nav: "requests",
      body: html`<h1>🔎 ${L(lang, "طلبات العملاء", "Client requests")}</h1>
${err ? html`<p class="notice" role="alert" data-error>${err[lang === "en" ? 1 : 0]}</p>` : ""}
<details class="card sheet"${req.query.error ? " open" : ""}>
  <summary>➕ ${L(lang, "طلب جديد", "New request")}</summary>
  <form method="post" action="/app/requests" class="stack" data-add-request>
    <input type="hidden" name="_csrf" value="${csrf}">
    <label>${L(lang, "العميل عايز إيه؟", "What does the client want?")} <input name="q" required maxlength="300" placeholder="${L(lang, "شقة ٣ غرف في التجمع لحد ٥ مليون", "3-bedroom apartment in New Cairo up to 5 million")}"></label>
    <label>${L(lang, "اربطه بعميل (اختياري): الكود أو رقم التليفون", "Link to a client (optional): code or phone number")} <input name="lead" maxlength="40" dir="ltr" placeholder="L-0042 / 01012345678"></label>
    <button type="submit">${L(lang, "حفظ الطلب", "Save the request")}</button>
  </form>
</details>
<div class="tab-bar" role="tablist" data-request-tabs>
  <a role="tab" href="${link("pending")}"${tab === "pending" ? " aria-current=\"page\"" : ""}>${L(lang, "الحالية", "Pending")} (${out.pending})</a>
  <a role="tab" href="${link("fulfilled")}"${tab === "fulfilled" ? " aria-current=\"page\"" : ""}>${L(lang, "اتنفذت", "Fulfilled")} (${out.fulfilled})</a>
</div>
${out.items.length
  ? html`<ul class="results">${out.items.map(
      (it) => html`<li class="card" data-request="${it.id}">
  <p><strong>${summary(it)}</strong>${it.alerts ? " 🔔" : ""}</p>
  <p class="muted small">${it.lead ? html`<a href="/app/leads/${it.lead.ref}" data-lead-link>👤 ${it.lead.ref} · ${Card.displayName({ name: it.lead.name, phone_e164: it.lead.phone_e164 }, lang)}</a>` : L(lang, "من غير عميل", "No client linked")}${broker.id && it.broker_name && req.query.all !== "0" ? ` · ${it.broker_name}` : ""} · ${day(it.fulfilled_at || it.created_at)}</p>
  <div class="row">
    ${tab === "pending" ? html`<a class="btn secondary" href="/app/search?f=${it.token}">🏠 ${it.matches} ${L(lang, "وحدة مناسبة", "fit now")}</a>` : html`<a class="btn secondary" href="/app/search?f=${it.token}">${L(lang, "ابحث تاني", "Search again")}</a>`}
    ${tab === "pending" ? html`<form method="post" action="/app/requests/${it.id}/fulfil" class="inline"><input type="hidden" name="_csrf" value="${csrf}"><button type="submit" class="secondary">✅ ${L(lang, "اتنفذ", "Mark fulfilled")}</button></form>` : ""}
    <form method="post" action="/app/requests/${it.id}/delete" class="inline" data-confirm="${L(lang, "متأكد؟ مش هينفع ترجع.", "Are you sure? This can't be undone.")}"><input type="hidden" name="_csrf" value="${csrf}"><button type="submit" class="link">🗑️ ${L(lang, "امسح", "Delete")}</button></form>
  </div>
</li>`
    )}</ul>
${out.pages > 1
  ? html`<nav class="row" aria-label="pages">${out.page > 1 ? html`<a class="btn secondary" href="${link(tab, out.page - 1)}">${L(lang, "→ السابق", "← Previous")}</a>` : ""}<span class="muted">${out.page} / ${out.pages}</span>${out.page < out.pages ? html`<a class="btn secondary" href="${link(tab, out.page + 1)}">${L(lang, "التالي ←", "Next →")}</a>` : ""}</nav>`
  : ""}`
  : html`<p class="card muted" data-empty>${tab === "pending" ? L(lang, "مفيش طلبات مفتوحة. ضيف طلب وهبلغك أول ما تنزل وحدة تناسبه.", "No open requests. Add one and you'll hear when a unit that fits comes in.") : L(lang, "مفيش طلبات اتنفذت لسه.", "Nothing fulfilled yet.")}</p>`}`
    });
  });

  web.post("/requests", async (req, res) => {
    const out = await Requests.add(pool, req.session.broker, { q: req.body.q, lead: req.body.lead });
    if (out.error) return res.redirect(303, `/app/requests?error=${out.error}`);
    return res.redirect(303, out.lead ? `/app/leads/${out.lead.ref}#requests` : "/app/requests");
  });

  web.post("/requests/:id/fulfil", async (req, res) => {
    await Requests.fulfil(pool, req.session.broker, req.params.id);
    return res.redirect(303, "/app/requests?tab=fulfilled");
  });

  web.post("/requests/:id/delete", async (req, res) => {
    await Requests.remove(pool, req.session.broker, req.params.id);
    return res.redirect(303, req.get("referer") && /tab=fulfilled/.test(req.get("referer")) ? "/app/requests?tab=fulfilled" : "/app/requests");
  });
}

module.exports = { register };
