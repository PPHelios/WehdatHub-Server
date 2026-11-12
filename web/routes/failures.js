// web/routes/failures.js — Failed and refused actions (services/failures.js), CRM owner only.
"use strict";

const Failures = require("../../services/failures");
const LeadRules = require("../../services/leadRules");
const Authz = require("../../lib/authz");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dayStart = (v) => (DAY.test(String(v || "")) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? LeadRules.cairoMidnight(String(v)) : null);
const dayEnd = (v) => (dayStart(v) ? new Date(dayStart(v).getTime() + 24 * 3600 * 1000) : null);
const when = (d) => new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Cairo", hour12: false });

function register(web, { pool, page }) {
  web.get("/failures", async (req, res, next) => {
    const { broker } = req.session;
    if (!Authz.isCrmOwner(broker)) return next();
    const lang = broker.preferred_lang === "en" ? "en" : "ar";
    const n = Math.max(0, parseInt(req.query.page, 10) || 0);
    const fromDay = dayStart(req.query.from) ? String(req.query.from) : "";
    const toDay = dayEnd(req.query.to) ? String(req.query.to) : "";
    const agency = UUID.test(String(req.query.agency || "")) ? String(req.query.agency) : "";
    const person = UUID.test(String(req.query.person || "")) ? String(req.query.person) : "";
    const rows = await Failures.list(pool, { agency: agency || null, person: person || null, from: dayStart(fromDay), to: dayEnd(toDay), offset: n * Failures.PAGE });
    const more = rows.length > Failures.PAGE;
    const shown = rows.slice(0, Failures.PAGE);
    const f = await Failures.filters(pool);
    const link = (p) => `/app/failures?${new URLSearchParams({ ...(fromDay ? { from: fromDay } : {}), ...(toDay ? { to: toDay } : {}), ...(agency ? { agency } : {}), ...(person ? { person } : {}), page: String(p) })}`;
    return page(req, res, {
      title: L(lang, "الأخطاء والرفض", "Failures"),
      nav: "notifications",
      body: html`<h1>⚠️ ${L(lang, "الأخطاء والعمليات المرفوضة", "Failed and refused actions")}</h1>
<p class="muted">${L(lang, `كل عملية فشلت أو اترفضت، بالسبب. بتتحفظ ${Failures.KEEP_DAYS} يوم.`, `Every failed or refused action, with its reason. Kept ${Failures.KEEP_DAYS} days.`)}</p>
<form method="get" action="/app/failures" class="row">
  <label>${L(lang, "من", "From")} <input type="date" name="from" value="${fromDay}"></label>
  <label>${L(lang, "لغاية", "To")} <input type="date" name="to" value="${toDay}"></label>
  <label>${L(lang, "الشركة", "Agency")} <select name="agency"><option value="">${L(lang, "الكل", "All")}</option>${f.agencies.map((a) => html`<option value="${a.id}"${a.id === agency ? html` selected` : ""}>${a.name}</option>`)}</select></label>
  <label>${L(lang, "مين", "Who")} <select name="person"><option value="">${L(lang, "الكل", "Everyone")}</option>${f.people.map((p) => html`<option value="${p.id}"${p.id === person ? html` selected` : ""}>${p.name}</option>`)}</select></label>
  <button type="submit">${L(lang, "تصفية", "Filter")}</button>
</form>
${shown.length
  ? html`<ul class="rows">${shown.map((r) => html`<li class="listrow"><span><b>${r.error_code || "?"}</b> <span class="muted">${r.operation_type}${r.metadata?.route ? ` · ${r.metadata.method || ""} ${r.metadata.route}` : ""}${r.listing_code ? ` · ${r.listing_code}` : ""}</span><br><span class="muted">${r.agency_name || "—"} · ${r.broker_name || "—"}</span></span><span class="muted" dir="ltr">${when(r.created_at)}</span></li>`)}</ul>`
  : html`<p class="muted">${L(lang, "مفيش أخطاء في الفترة دي. 🎉", "No failures in this period. 🎉")}</p>`}
<p class="row">${n > 0 ? html`<a class="btn secondary" href="${link(n - 1)}">${L(lang, "السابق", "Newer")}</a>` : ""}${more ? html`<a class="btn secondary" href="${link(n + 1)}">${L(lang, "التالي", "Older")}</a>` : ""}</p>`
    });
  });
}

module.exports = { register };
