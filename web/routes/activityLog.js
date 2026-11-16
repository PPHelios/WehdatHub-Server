// web/routes/activityLog.js — The activity log page for managers and the agency owner (services/activityLog.js).
// Filters: a date range (Cairo days, both ends inclusive) and the person who acted.
"use strict";

const ActivityLog = require("../../services/activityLog");
const LeadRules = require("../../services/leadRules");
const Dash = require("../../services/dashboards");
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
    const action = String(req.query.action || "").trim().slice(0, 40);
    const log = await ActivityLog.list(pool, broker, { offset: n * ActivityLog.PAGE, from: dayStart(fromDay), to: dayEnd(toDay), person: person || null, action: action || null });
    if (!log) return next();
    const people = await ActivityLog.people(pool, broker);
    const groups = ActivityLog.groupByDay(log.rows);
    const techOk = Dash.isOwner(broker);
    const dayLabel = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString(lang === "en" ? "en-GB" : "ar-EG", { timeZone: "Africa/Cairo", weekday: "long", day: "numeric", month: "long" });
    const timeOf = (iso) => new Date(iso).toLocaleTimeString(lang === "en" ? "en-GB" : "ar-EG", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit" });
    const pageLink = (p) => {
      const q = new URLSearchParams({ ...(fromDay ? { from: fromDay } : {}), ...(toDay ? { to: toDay } : {}), ...(person ? { person } : {}), ...(action ? { action } : {}), page: String(p) });
      return `/app/activity-log?${q.toString()}`;
    };
    return page(req, res, {
      title: L(lang, "سجل النشاط", "Activity log"),
      nav: "notifications",
      body: html`<h1>🗂️ ${L(lang, "سجل النشاط", "Activity log")}</h1>
<p class="muted">${L(lang, `كل العمليات المهمة: مين عملها وإمتى ومن أي جهاز. بيتحفظ ${ActivityLog.KEEP_DAYS} يوم.`, `Every important action: who, when and from which device. Kept ${ActivityLog.KEEP_DAYS} days.`)}</p>
<form method="get" action="/app/activity-log" class="row" data-activity-filter>
  <label>${L(lang, "من", "From")} <input type="date" name="from" value="${fromDay}"></label>
  <label>${L(lang, "لغاية", "To")} <input type="date" name="to" value="${toDay}"></label>
  <label>${L(lang, "مين", "Who")}
    <select name="person"><option value="">${L(lang, "الكل", "Everyone")}</option>${people.map((p) => html`<option value="${p.id}"${p.id === person ? html` selected` : ""}>${p.name}</option>`)}</select></label>
  <label>${L(lang, "العملية", "Action")} <input type="search" name="action" value="${action}" maxlength="40"></label>
  <button type="submit" class="secondary">${L(lang, "فلتر", "Filter")}</button>
</form>
<div class="stack" data-activity-log>${groups.length ? groups.map((g) => html`<section class="card log-day" data-day="${g.day}"><h2>${dayLabel(g.day)}</h2><ul class="log-list">${g.rows.map((r) => html`<li data-log="${r.id}"><span class="log-ic" aria-hidden="true">${ActivityLog.iconOf(r.operation_type)}</span><span class="log-main"><span><b>${r.broker_name || ""}</b> ${ActivityLog.describe(r, lang)}</span><span class="muted small">${timeOf(r.created_at)}</span>${techOk ? html`<details class="small"><summary>${L(lang, "تفاصيل", "Details")}</summary><span dir="ltr" class="muted">${r.operation_type} · ${r.ip || ""} ${String(r.user_agent || "").slice(0, 60)}</span></details>` : ""}</span></li>`)}</ul></section>`) : html`<p class="card muted">${L(lang, "مفيش حاجة في الفترة دي.", "Nothing in this period.")}</p>`}</div>
<p class="row">${n > 0 ? html`<a href="${pageLink(n - 1)}">${L(lang, "→ الأحدث", "← Newer")}</a>` : ""} ${log.more ? html`<a href="${pageLink(n + 1)}">${L(lang, "الأقدم ←", "Older →")}</a>` : ""}</p>`,
    });
  });
}

module.exports = { register };
