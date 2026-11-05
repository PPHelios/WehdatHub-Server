// web/routes/openedLinks.js — "Opened links" (/app/links): one page for every unit link sent to a client, with filters,
// search by number or lead, and 20 a page. Scope and rules: services/openedLinks.js. Data entry is not offered this page
// (web/html.js and web/index.js keep it out of their menu and paths).
"use strict";

const OpenedLinks = require("../../services/openedLinks");
const Card = require("../../domain/leadCard");
const Authz = require("../../lib/authz");
const { html } = require("../html");
const { icon } = require("../icons");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const STATUS_LABEL = {
  all: ["الكل", "All"],
  never: ["ما اتفتحتش", "Never opened"],
  opened: ["اتفتحت", "Opened"],
  repeat: ["اتفتحت أكتر من مرة", "Opened more than once"],
  recent: ["اتفتحت آخر ٤٨ ساعة", "Opened in the last 48 hours"]
};
const CHANNEL_LABEL = { all: ["الكل", "All"], whatsapp: ["واتساب", "WhatsApp"], web: ["الموقع", "Website"] };
const SOURCE_LABEL = { bot: ["من البوت", "From the bot"], web: ["من الموقع", "From the website"], lead: ["من عميل", "From a lead"] };

const when = (d, lang) => (d ? new Date(d).toLocaleString(lang === "en" ? "en-GB" : "ar-EG", { timeZone: "Africa/Cairo", dateStyle: "short", timeStyle: "short" }) : "—");

function filtersForm({ f, lang, brokers, teamLeads, manager }) {
  const sel = (name, value, options, label) =>
    html`<label>${label}<select name="${name}">${options.map(([v, text]) => html`<option value="${v}"${v === value ? html` selected` : ""}>${text}</option>`)}</select></label>`;
  return html`<form method="get" action="/app/links" class="stack" data-links-filters>
  <div class="searchbox">${icon("search", 20)}<input name="q" value="${f.q}" dir="auto" aria-label="${L(lang, "بحث برقم أو اسم العميل أو كود الوحدة", "Search by number, lead name or unit code")}" placeholder="${L(lang, "رقم العميل، اسمه، أو كود الوحدة", "Client number, name or unit code")}"><button type="submit" class="sr-only">${L(lang, "بحث", "Search")}</button></div>
  <details class="card sheet"${f.status !== "all" || f.channel !== "all" || f.broker || f.team ? html` open` : ""}><summary>${L(lang, "الفلاتر", "Filters")}</summary>
    <div class="grid two">
      ${sel("status", f.status, Object.keys(STATUS_LABEL).map((k) => [k, L(lang, ...STATUS_LABEL[k])]), L(lang, "الحالة", "Status"))}
      ${sel("channel", f.channel, Object.keys(CHANNEL_LABEL).map((k) => [k, L(lang, ...CHANNEL_LABEL[k])]), L(lang, "القناة", "Channel"))}
      ${sel("source", f.source, [["all", L(lang, "كل المصادر", "All sources")], ...Object.keys(SOURCE_LABEL).map((k) => [k, L(lang, ...SOURCE_LABEL[k])])], L(lang, "المصدر", "Source"))}
      ${manager ? sel("team", f.team || "", [["", L(lang, "كل الفرق", "All teams")], ...teamLeads.map((t) => [t.id, t.name])], L(lang, "الفريق", "Team")) : ""}
      ${manager ? sel("broker", f.broker || "", [["", L(lang, "كل الوسطاء", "All brokers")], ...brokers.map((b) => [b.id, b.name])], L(lang, "البروكر", "Broker")) : ""}
    </div>
    <div class="row sheet-actions"><button type="submit">${L(lang, "تطبيق", "Apply")}</button><a class="btn secondary" href="/app/links">${L(lang, "مسح", "Clear")}</a></div>
  </details>
</form>`;
}

function linkRow(r, lang) {
  const lead = r.lead
    ? r.lead.hidden
      ? html`<span class="muted">${L(lang, "عميل", "Lead")} ${Card.refLabel(r.lead.ref)} · ${L(lang, "مش ظاهر ليك", "not visible to you")}</span>`
      : html`<span>${Card.refLabel(r.lead.ref)} ${r.lead.name || ""}${r.lead.phone ? html` <span dir="ltr" class="muted">${r.lead.phone}</span>` : ""}</span>`
    : html`<span class="muted">${L(lang, "من غير عميل محدد", "No lead named")}</span>`;
  const recent = r.last_opened_at && Date.now() - new Date(r.last_opened_at).getTime() < 48 * 3600 * 1000;
  return html`<li class="card result" data-opened-link data-opens="${r.open_count}">
  <div class="row between"><a href="/app/units/${encodeURIComponent(r.unit_code)}"><b dir="ltr">${r.unit_code}</b> <span class="muted">${r.property_type || ""}${r.compound ? ` · ${r.compound}` : ""}</span></a>
  ${recent ? html`<span class="badge" data-recent>🔥 ${L(lang, "جديد", "New")}</span>` : ""}</div>
  <p class="small">${lead}${r.recipient_phone ? html` · <span dir="ltr">${r.recipient_phone}</span>` : html` · <span class="muted">${L(lang, "من غير مستلم", "no recipient")}</span>`}</p>
  <p class="muted small">${L(lang, "اتبعت بواسطة", "Sent by")} ${r.sent_by || "—"} · ${CHANNEL_LABEL[r.channel] ? L(lang, ...CHANNEL_LABEL[r.channel]) : r.channel}${r.source ? ` · ${SOURCE_LABEL[r.source] ? L(lang, ...SOURCE_LABEL[r.source]) : r.source}` : ""} · ${when(r.created_at, lang)}</p>
  ${r.devices > 1 ? html`<p class="small" data-devices="${r.devices}">📱 ${L(lang, `اتفتح من ${r.devices} أجهزة: ممكن اتبعت تاني`, `opened from ${r.devices} devices: it may have been forwarded`)}</p>` : ""}
  ${r.note ? html`<p class="muted small">📝 ${r.note}</p>` : ""}
  <p class="small"><b>${L(lang, `اتفتح ${r.open_count} مرة`, `Opened ${r.open_count} time(s)`)}</b>${r.last_opened_at ? html` · ${L(lang, "آخر فتحة", "last")} <span dir="ltr">${when(r.last_opened_at, lang)}</span>` : ""}</p>
</li>`;
}

function register(web, { pool, page }) {
  web.get("/links", async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const manager = Authz.isManager(broker);
    const f = {
      q: String(req.query.q || "").slice(0, 60),
      status: OpenedLinks.STATUSES.includes(req.query.status) ? req.query.status : "all",
      channel: OpenedLinks.CHANNELS.includes(req.query.channel) ? req.query.channel : "all",
      source: OpenedLinks.SOURCES.includes(req.query.source) ? req.query.source : "all",
      broker: manager ? String(req.query.broker || "") : "",
      team: manager ? String(req.query.team || "") : "",
      page: req.query.page
    };
    const out = await OpenedLinks.list(pool, broker, f);
    const brokers = manager ? (await pool.query("SELECT id, name, lower(role) = 'team_lead' AS is_team_lead FROM brokers WHERE agency_id = $1 AND is_active ORDER BY name", [broker.agency_id])).rows : [];
    const teamLeads = manager ? brokers.filter((b) => b.is_team_lead) : [];
    const pageLink = (p) => {
      const qs = new URLSearchParams({ q: f.q, status: f.status, channel: f.channel, source: f.source, broker: f.broker, team: f.team, page: p });
      for (const [k, v] of [...qs.entries()]) if (v === "" || v === "all" || v === "0") qs.delete(k);
      return `/app/links?${qs.toString()}`;
    };
    const body = html`<h1>🔗 ${L(lang, "الروابط المفتوحة", "Opened links")}</h1>
<p class="muted">${L(lang, "كل رابط وحدة اتبعت للعميل، مين بعته، لمين، وإمتى اتفتح. ", "Every unit link sent to a client: who sent it, to whom, and when it was opened. ")}</p>
${filtersForm({ f, lang, brokers, teamLeads, manager })}
<p class="muted small" data-total="${out.total}">${L(lang, `${out.total} رابط`, `${out.total} link(s)`)}${out.pages > 1 ? L(lang, ` · صفحة ${out.page + 1} من ${out.pages}`, ` · page ${out.page + 1} of ${out.pages}`) : ""}</p>
${out.rows.length
  ? html`<ol class="results">${out.rows.map((r) => linkRow(r, lang))}</ol>
<nav class="row" aria-label="${L(lang, "الصفحات", "Pages")}">${out.page > 0 ? html`<a class="btn secondary" href="${pageLink(out.page - 1)}">${L(lang, "→ السابق", "← Previous")}</a>` : html`<span></span>`}${out.page + 1 < out.pages ? html`<a class="btn secondary" href="${pageLink(out.page + 1)}">${L(lang, "التالي ←", "Next →")}</a>` : ""}</nav>`
  : html`<div class="card empty"><p data-total="0">${L(lang, "مفيش روابط بالشروط دي.", "No links match.")}</p></div>`}`;
    return page(req, res, { title: L(lang, "الروابط المفتوحة", "Opened links"), nav: "links", body });
  });
}

module.exports = { register, linkRow };
