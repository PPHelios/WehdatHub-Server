// web/views/analytics.js — The market analytics pages (pure drawing): the owner's tab and the agency's /app/market page.
// Simple tables and <progress> bars, no chart library. Cells too small to be shown say "Not enough data" (بيانات قليلة).
// Only aggregate numbers arrive here (services/analytics.js); no name, phone or note exists in them.
"use strict";

const { html } = require("../html");
const { L } = require("../../lib/copy");
const { TYPE_LABELS } = require("../../domain/describe");

const num = (n, d = 0) => (n === null || n === undefined ? null : Number(n).toLocaleString("en-US", { maximumFractionDigits: d }));
const when = (iso) => (iso ? `${new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Cairo", hour12: false })} (Cairo)` : "—");

const few = (lang) => html`<span class="muted" data-suppressed>${L(lang, "بيانات قليلة", "Not enough data")}</span>`;
const val = (v, lang, d = 0) => (v === null || v === undefined ? few(lang) : num(v, d));
const placeName = (r, lang) => (lang === "en" ? r.name_en || r.name_ar : r.name_ar || r.name_en) || "—";
const typeName = (t, lang) => (t === "any" || t === "all" ? L(lang, "كل الأنواع", "All types") : TYPE_LABELS[t] ? TYPE_LABELS[t][lang === "en" ? 1 : 0] : t);
const ltName = (t, lang) => (t === "sale" ? L(lang, "بيع", "Sale") : t === "rent" ? L(lang, "إيجار", "Rent") : L(lang, "الكل", "All"));
const bar = (v, max) => html`<progress max="${Math.max(1, max)}" value="${Math.max(0, Number(v) || 0)}"></progress>`;

const wrap = (rows, empty, lang) => (rows ? rows : html`<p class="muted">${empty || L(lang, "مفيش بيانات لسه.", "No data yet.")}</p>`);

function demandSection(r, lang) {
  const max = Math.max(1, ...r.demand.map((x) => x.searches || 0));
  return html`<section class="card" id="an-demand"><h2>${L(lang, "الطلب والمعروض", "Demand and supply")}</h2>
  <p class="muted">${L(lang, "عمليات البحث في آخر 30 يوم قصاد الوحدات المتاحة. الأحمر = ناس بتدور ومفيش نتيجة.", "Searches in the last 30 days against units on the market. Highlighted = people search and find nothing.")}</p>
  ${wrap(r.demand.length ? html`<div class="scroll"><table><thead><tr><th>${L(lang, "المكان", "Place")}</th><th>${L(lang, "النوع", "Type")}</th><th>${L(lang, "بحث", "Searches")}</th><th>${L(lang, "من غير نتيجة", "No result")}</th><th>${L(lang, "وحدات متاحة", "Units on market")}</th></tr></thead>
  <tbody>${r.demand.map((x) => html`<tr data-demand${x.hot ? html` class="hot" data-hot="1"` : ""}><td>${placeName(x, lang)}</td><td>${typeName(x.property_type, lang)} · ${ltName(x.listing_type, lang)}</td>
    <td>${x.suppressed ? few(lang) : html`${num(x.searches)} ${bar(x.searches, max)}`}</td><td>${x.suppressed ? few(lang) : html`${num(x.zero_result)} (${x.zero_pct}%)${x.hot ? " 🔥" : ""}`}</td><td>${x.supply === null ? few(lang) : num(x.supply)}</td></tr>`)}</tbody></table></div>` : "", null, lang)}
  <h3>${L(lang, "عدد الأوض المطلوبة", "Bedrooms asked for")}</h3>
  ${wrap(r.demandBeds.length ? html`<table><tbody>${r.demandBeds.map((x) => html`<tr data-beds><td>${ltName(x.listing_type, lang)} · ${x.bedroom_band}</td><td>${val(x.searches, lang)}</td><td>${x.suppressed ? "" : html`${num(x.zero_result)} ${L(lang, "من غير نتيجة", "no result")}`}</td></tr>`)}</tbody></table>` : "", null, lang)}
</section>`;
}

function priceSection(r, lang) {
  const max = Math.max(1, ...r.prices.flatMap((x) => x.trend.map((t) => t.p50)));
  return html`<section class="card" id="an-prices"><h2>${L(lang, "سعر المتر حسب المنطقة", "Price per m² by place")}</h2>
  <p class="muted">${L(lang, "الوسيط الشهري (ج.م للمتر) والاتجاه. الأرقام من الوحدات المعروضة (سعر الطلب).", "Monthly median (EGP per m²) and trend. From listed units (asking prices).")}</p>
  ${wrap(r.prices.length ? html`<div class="scroll"><table><thead><tr><th>${L(lang, "المكان", "Place")}</th><th>${L(lang, "النوع", "Type")}</th><th>${L(lang, "الوسيط", "Median")}</th><th>${L(lang, "من – لحد", "Low – High")}</th><th>${L(lang, "الاتجاه (شهري)", "Trend (monthly)")}</th></tr></thead>
  <tbody>${r.prices.map((x) => html`<tr data-price><td>${placeName(x, lang)}</td><td>${typeName(x.property_type, lang)} · ${ltName(x.listing_type, lang)}</td><td><b>${num(x.last.p50)}</b></td><td dir="ltr">${num(x.last.p25)} – ${num(x.last.p75)}</td>
    <td>${x.trend.map((t) => html`<div class="small" dir="ltr">${t.month} ${bar(t.p50, max)} ${num(t.p50)}</div>`)}</td></tr>`)}</tbody></table></div>` : "", null, lang)}
</section>`;
}

function closeSection(r, lang) {
  return html`<section class="card" id="an-close"><h2>${L(lang, "مدة البيع وفرق السعر", "Time to close and price gap")}</h2>
  <p class="muted">${L(lang, "آخر 90 يوم. الفرق = سعر الصفقة مقارنة بسعر العرض (سالب = اتباع بأقل).", "Last 90 days. Gap = the deal price against the asking price (negative = closed below asking).")}</p>
  ${wrap(r.closing.length ? html`<div class="scroll"><table><thead><tr><th>${L(lang, "المكان", "Place")}</th><th>${L(lang, "النوع", "Type")}</th><th>${L(lang, "اتباع", "Closed")}</th><th>${L(lang, "أيام لحد البيع", "Days to close")}</th><th>${L(lang, "الفرق عن العرض %", "Gap to asking %")}</th></tr></thead>
  <tbody>${r.closing.map((x) => html`<tr data-close><td>${placeName(x, lang)}</td><td>${typeName(x.property_type, lang)} · ${ltName(x.listing_type, lang)}</td><td>${num(x.sold)}</td><td>${val(x.days, lang, 1)}</td><td dir="ltr">${val(x.gap_pct, lang, 1)}</td></tr>`)}</tbody></table></div>` : "", null, lang)}
</section>`;
}

function seasonSection(r, lang) {
  const maxU = Math.max(1, ...r.seasonality.map((x) => x.new_units || 0));
  const maxS = Math.max(1, ...r.seasonality.map((x) => x.searches || 0));
  return html`<section class="card" id="an-season"><h2>${L(lang, "المواسم", "Seasonality")}</h2>
  ${wrap(r.seasonality.length ? html`<div class="scroll"><table><thead><tr><th>${L(lang, "الشهر", "Month")}</th><th>${L(lang, "وحدات جديدة", "New units")}</th><th>${L(lang, "عمليات بحث", "Searches")}</th></tr></thead>
  <tbody>${r.seasonality.map((x) => html`<tr data-month="${x.month}"><td dir="ltr">${x.month}</td><td>${val(x.new_units, lang)} ${x.new_units ? bar(x.new_units, maxU) : ""}</td><td>${val(x.searches, lang)} ${x.searches ? bar(x.searches, maxS) : ""}</td></tr>`)}</tbody></table></div>` : "", null, lang)}
</section>`;
}

const RATES = [["contacted_pct", "اتكلمنا معاهم %", "Contacted %"], ["viewing_pct", "وصلوا لمعاينة %", "Reached a viewing %"], ["deals_pct", "صفقات %", "Deals %"], ["lost_pct", "ضاعوا %", "Lost %"]];

/** The funnel: the agency's months beside the market median. title: the agency's name for the owner's picker, or "Your agency". */
function funnelSection(market, own, lang, { title = null, picker = "" } = {}) {
  const byMonth = new Map(market.map((m) => [m.month, m]));
  const months = [...new Set([...own.map((o) => o.month), ...market.map((m) => m.month)])].sort().slice(-6);
  const ownBy = new Map(own.map((o) => [o.month, o]));
  const rateCell = (row, k) => (row && row.rates && row.rates[k] !== null && row.rates[k] !== undefined ? `${num(row.rates[k], 1)}%` : "—");
  return html`<section class="card" id="an-funnel"><h2>${L(lang, "مقارنة مسار العملاء", "Lead funnel benchmark")}</h2>
  <p class="muted">${L(lang, "الشركة قصاد وسيط السوق. الوسيط مش بيظهر غير لما يكون فيه شركات كفاية.", "The agency against the market median. The median shows only when enough agencies stand behind it.")}</p>
  ${picker}
  <h3>${title || L(lang, "شركتك", "Your agency")}</h3>
  ${wrap(months.length ? html`<div class="scroll"><table><thead><tr><th>${L(lang, "الشهر", "Month")}</th><th></th><th>${L(lang, "عملاء", "Leads")}</th>${RATES.map(([, ar, en]) => html`<th>${L(lang, ar, en)}</th>`)}<th>${L(lang, "دقايق لأول رد", "Minutes to first reply")}</th></tr></thead>
  <tbody>${months.map((mo) => {
    const o = ownBy.get(mo);
    const m = byMonth.get(mo);
    return html`<tr data-funnel="own" data-month="${mo}"><td dir="ltr" rowspan="2">${mo}</td><td>${L(lang, "الشركة", "Agency")}</td><td>${o ? num(o.leads) : "—"}</td>${RATES.map(([k]) => html`<td>${rateCell(o, k)}</td>`)}<td>${o && o.response_min !== null ? num(o.response_min, 1) : "—"}</td></tr>
    <tr data-funnel="market" data-month="${mo}"><td>${L(lang, "وسيط السوق", "Market median")}</td><td>${m ? num(m.leads) : few(lang)}</td>${RATES.map(([k]) => html`<td>${m ? rateCell(m, k) : few(lang)}</td>`)}<td>${m && m.response_min !== null ? num(m.response_min, 1) : m ? "—" : few(lang)}</td></tr>`;
  })}</tbody></table></div>` : "", null, lang)}
</section>`;
}

const reports = (r, lang) => html`${demandSection(r, lang)}${priceSection(r, lang)}${closeSection(r, lang)}${seasonSection(r, lang)}`;

/** The owner's tab: last run, row counts, the agency switches, CSV links, the reports and the funnel benchmark (agency picker). */
function ownerTab(data, st, lang, csrf) {
  const t = st.tables || {};
  const rowsLine = [["search_daily", "بحث يومي", "Daily searches"], ["market_daily", "سوق يومي", "Daily market"], ["funnel_monthly", "مسار شهري", "Monthly funnel"], ["status_events", "تغييرات الحالة", "Status changes"], ["price_history", "تاريخ الأسعار", "Price history"]];
  const picker = html`<form method="get" action="/app/owner" class="row"><label>${L(lang, "الشركة", "Agency")} <select name="an_agency">${data.agencies.map((a) => html`<option value="${a.id}"${a.id === data.agencyId ? html` selected` : ""}>${a.name}</option>`)}</select></label><button type="submit" class="secondary">${L(lang, "اعرض", "Show")}</button></form>`;
  const picked = data.agencies.find((a) => a.id === data.agencyId);
  return html`<section class="card" id="an-status" data-analytics-status><h2>${L(lang, "تحليلات السوق", "Market analytics")}</h2>
  <p class="muted">${L(lang, "أرقام مجمّعة ومجهولة. مفيش أسماء ولا تليفونات ولا نص بحث. بتتحسب كل ليلة.", "Aggregate, anonymous numbers. No names, phones or search text. Computed every night.")}</p>
  <p>${L(lang, "آخر تشغيل", "Last run")}: <b dir="ltr" data-last-run>${when(st.lastRunAt)}</b>${st.job && st.job.status === "failed" ? html` <span class="chip late">❌ ${st.job.error || ""}</span>` : ""}</p>
  <table class="kv"><tbody>${rowsLine.map(([k, ar, en]) => html`<tr data-count="${k}"><th>${L(lang, ar, en)}</th><td>${num(t[k]) ?? "—"}</td></tr>`)}</tbody></table>
  <p class="row">${["market_daily", "funnel_monthly", "search_daily"].map((k) => html`<a class="btn secondary small" href="/app/owner/analytics/${k}.csv" data-csv="${k}">⬇ CSV · ${k}</a>`)}</p>
</section>
<section class="card" id="an-switches"><h2>${L(lang, "مين يشوف التحليلات", "Who sees analytics")}</h2>
  <p class="muted">${L(lang, "لما تفتحها لشركة، مديرينها بس (مش البروكرز) بيشوفوا صفحة «السوق» بمسار عملائهم جنب وسيط السوق.", "When on for an agency, only its managers (not brokers) see the Market page with their own funnel next to the market median.")}</p>
  <table><tbody>${data.agencies.map((a) => html`<tr data-agency-switch="${a.id}"><td>${a.name}</td><td>${a.analytics_enabled ? "✅" : "—"}</td><td><form method="post" action="/app/owner/agencies/${a.id}/analytics"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="from" value="tab"><input type="hidden" name="on" value="${a.analytics_enabled ? "0" : "1"}"><button type="submit" class="secondary small">${a.analytics_enabled ? L(lang, "اقفل", "Turn off") : L(lang, "افتح", "Turn on")}</button></form></td></tr>`)}</tbody></table>
</section>
${funnelSection(data.marketFunnel, data.agencyFunnel, lang, { title: picked ? picked.name : null, picker })}
${reports(data.reports, lang)}`;
}

/** The agency's page (/app/market): own funnel beside the market median, then the market reports for its places. */
function agencyPage(data, lang) {
  return html`<h1>📈 ${L(lang, "السوق", "Market")}</h1>
<p class="muted">${L(lang, "أرقام مجمّعة ومجهولة من السوق، ومسار عملاء شركتك جنب الوسيط. بتتحدث كل ليلة.", "Anonymous aggregate market numbers, and your own lead funnel next to the median. Updated every night.")}</p>
${funnelSection(data.marketFunnel, data.agencyFunnel, lang)}
${data.placesN ? reports(data.reports, lang) : html`<section class="card"><p class="muted">${L(lang, "هتظهر تقارير السوق للمناطق اللي عندك فيها وحدات لما تضيف وحدات بمنطقة معروفة.", "Market reports appear for the places where you have units, once you add units in a known place.")}</p></section>`}`;
}

module.exports = { ownerTab, agencyPage, reports, funnelSection };
