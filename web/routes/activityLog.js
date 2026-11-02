// web/routes/activityLog.js — The activity log page for managers and the agency owner (services/activityLog.js).
// Filters: a date range (Cairo days, both ends inclusive) and the person who acted.
"use strict";

const ActivityLog = require("../../services/activityLog");
const LeadRules = require("../../services/leadRules");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dayStart = (v) => (DAY.test(String(v || "")) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? LeadRules.cairoMidnight(String(v)) : null);
const dayEnd = (v) => (dayStart(v) ? new Date(dayStart(v).getTime() + 24 * 3600 * 1000) : null);

function register(web, { pool, page }) {
  web.get("/activity-log", async (req, res, next) => {
    const { broker } = req.session;
    const lang = broker.preferred_lang === "en" ? "en" : "ar";
    const n = Math.max(0, parseInt(req.query.page, 10) || 0);
    const fromDay = dayStart(req.query.from) ? String(req.query.from) : "";
    const toDay = dayEnd(req.query.to) ? String(req.query.to) : "";
    const person = UUID.test(String(req.query.person || "")) ? String(req.query.person) : "";
    const log = await ActivityLog.list(pool, broker, { offset: n * ActivityLog.PAGE, from: dayStart(fromDay), to: dayEnd(toDay), person: person || null });
    if (!log) return next();
    const people = await ActivityLog.people(pool, broker);
    const pageLink = (p) => {
      const q = new URLSearchParams({ ...(fromDay ? { from: fromDay } : {}), ...(toDay ? { to: toDay } : {}), ...(person ? { person } : {}), page: String(p) });
      return `/app/activity-log?${q.toString()}`;
    };
    return page(req, res, {
      title: L(lang, "سجل النشاط", "Activity log"),
      nav: "notifications",
      body: html`<h1>🗂️ ${L(lang, "سجل النشاط", "Activity log")}</h1>
<p class="muted">${L(lang, `طلبات البيانات الخاصة والردود عليها، وتنزيل الوحدات. بيتحفظ ${ActivityLog.KEEP_DAYS} يوم.`, `Requests for private details and the answers, and unit exports. Kept ${ActivityLog.KEEP_DAYS} days.`)}</p>
<form method="get" action="/app/activity-log" class="row" data-activity-filter>
  <label>${L(lang, "من", "From")} <input type="date" name="from" value="${fromDay}"></label>
  <label>${L(lang, "لغاية", "To")} <input type="date" name="to" value="${toDay}"></label>
  <label>${L(lang, "مين", "Who")}
    <select name="person"><option value="">${L(lang, "الكل", "Everyone")}</option>${people.map((p) => html`<option value="${p.id}"${p.id === person ? html` selected` : ""}>${p.name}</option>`)}</select></label>
  <button type="submit" class="secondary">${L(lang, "فلتر", "Filter")}</button>
</form>
<table data-activity-log>
<thead><tr><th>${L(lang, "الوقت", "Time")}</th><th>${L(lang, "مين", "Who")}</th><th>${L(lang, "إيه اللي حصل", "What happened")}</th></tr></thead>
<tbody>${log.rows.map((r) => html`<tr data-log="${r.id}"><td>${new Date(r.created_at).toLocaleString(lang === "en" ? "en-GB" : "ar-EG", { timeZone: "Africa/Cairo", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</td><td>${r.broker_name || ""}</td><td>${ActivityLog.describe(r, lang)}</td></tr>`)}</tbody>
</table>
<p class="row">${n > 0 ? html`<a href="${pageLink(n - 1)}">${L(lang, "→ الأحدث", "← Newer")}</a>` : ""} ${log.more ? html`<a href="${pageLink(n + 1)}">${L(lang, "الأقدم ←", "Older →")}</a>` : ""}</p>`,
    });
  });
}

module.exports = { register };
