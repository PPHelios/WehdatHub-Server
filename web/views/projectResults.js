// web/views/projectResults.js — Ask's grouped results: a count, sort pills, removable filter chips, a filter row (price, area, down payment,
// bedrooms), one card per project with its fitting offers (or its free text when it has no unit details), and page links.
// The data is services/projectSearch.js fromQuery(); the app shows the same list from GET /api/ask/results. Links and a GET form only: no script.
"use strict";

const { html, raw } = require("../html");
const { projectCard } = require("./projectCard");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const money = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
const SORTS = [
  ["best", "الأنسب", "Best match"],
  ["cheap", "الأرخص", "Cheapest"],
  ["pricey", "الأغلى", "Priciest"],
  ["small", "الأصغر", "Smallest"],
  ["big", "الأكبر", "Largest"],
  ["down", "أقل مقدم", "Lowest down payment"]
];
const CHIP_TEXT = {
  place: (v, lang) => `${L(lang, "المكان", "Place")}: ${[...(v.place_terms || []), ...(v.locations || [])].filter(Boolean).join("، ")}`,
  area: (v, lang) => `${L(lang, "المساحة", "Area")}: ${v.area_min != null && v.area_max != null ? `${v.area_min}-${v.area_max}` : v.area_min != null ? `${v.area_min}+` : `≤ ${v.area_max}`} m²`,
  price: (v, lang) => `${L(lang, "السعر", "Price")}: ${v.price_min != null ? money(v.price_min) : ""}${v.price_min != null && v.price_max != null ? " - " : v.price_max != null ? "≤ " : "+"}${v.price_max != null ? money(v.price_max) : ""}`,
  down: (v, lang) => `${L(lang, "المقدم لحد", "Down up to")} ${money(v.max_down_payment)}`,
  inst: (v, lang) => `${L(lang, "القسط لحد", "Installment up to")} ${money(v.max_installment)}`,
  beds: (v, lang) => `${L(lang, "الغرف", "Bedrooms")}: ${v.bedrooms_min}${v.bedrooms_max != null && v.bedrooms_max !== v.bedrooms_min ? `-${v.bedrooms_max}` : ""}`,
  features: (v, lang) => `${L(lang, "المميزات", "Features")}: ${(v.features || []).join("، ")}`
};
const STATUS = { launching: ["إطلاق جديد", "New launch"], selling: ["متاح", "Selling"], sold_out: ["اتباع", "Sold out"] };

/** Page numbers to show: first, last, and two either side of the current one, with gaps as null. */
function pageWindow(page, pages) {
  const keep = [...new Set([1, pages, ...[-2, -1, 0, 1, 2].map((d) => page + d)])].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
  return keep.flatMap((p, i) => (i && p - keep[i - 1] > 1 ? [null, p] : [p]));
}

/**
 * @param {object} r fromQuery() result
 * @param {{ q: string, sort: string, drop: string, explicit: object, base: string }} state base = the page's path, e.g. "/app/ask/results"
 */
function resultsView(lang, r, state) {
  const { q, sort, drop, explicit = {}, base } = state;
  const link = (extra) => {
    const u = new URLSearchParams({ q, sort, drop: drop || "", f: r.token || "", sl: r.log_id || "", ...explicit, page: "1", ...extra });
    for (const [k, v] of [...u.entries()]) if (v === "") u.delete(k);
    return `${base}?${u.toString()}`;
  };
  const dropped = r.dropped || [];
  const stat = r.total_projects
    ? `${r.total_projects} ${L(lang, "مشروع", "projects")} · ${r.total_options} ${L(lang, "اختيار", "options")}`
    : L(lang, "مفيش مشروع بالمواصفات دي", "No project matches");
  const f = r.filters || {};
  return html`<section class="stack" data-ask-results>
  <div class="rchips">${(r.chips || []).map((c) => html`<a class="rchip" data-chip="${c.key}" data-track="chip_drop" data-detail="${c.key}" href="${link({ drop: [...dropped, c.key].join(",") })}">${CHIP_TEXT[c.key] ? CHIP_TEXT[c.key](c.value, lang) : c.key}</a>`)}${dropped.length ? html`<a class="rchip reset" href="${link({ drop: "" })}">${L(lang, "رجّع الفلاتر", "Reset filters")}</a>` : ""}</div>
  <form method="get" action="${base}" class="rfilters" data-results-filters data-track="filter">
    <input type="hidden" name="q" value="${q}"><input type="hidden" name="f" value="${r.token || ""}"><input type="hidden" name="sl" value="${r.log_id || ""}"><input type="hidden" name="sort" value="${sort}"><input type="hidden" name="drop" value="${drop || ""}">
    <label>${L(lang, "السعر من", "Price from")} <input name="pmin" inputmode="decimal" dir="ltr" size="9" value="${f.price_min ?? ""}"></label>
    <label>${L(lang, "لحد", "to")} <input name="pmax" inputmode="decimal" dir="ltr" size="9" value="${f.price_max ?? ""}"></label>
    <label>${L(lang, "المساحة من", "Area from")} <input name="amin" inputmode="decimal" dir="ltr" size="5" value="${f.area_min ?? ""}"></label>
    <label>${L(lang, "لحد", "to")} <input name="amax" inputmode="decimal" dir="ltr" size="5" value="${f.area_max ?? ""}"></label>
    <label>${L(lang, "المقدم لحد", "Down up to")} <input name="dmax" inputmode="decimal" dir="ltr" size="9" value="${f.max_down_payment ?? ""}"></label>
    <label>${L(lang, "الغرف", "Bedrooms")} <select name="bed"><option value="">—</option>${[1, 2, 3, 4, 5, 6].map((b) => html`<option value="${b}"${f.bedrooms === b ? raw(" selected") : ""}>${b}</option>`)}</select></label>
    <label class="check"><input type="checkbox" name="units" value="1"${explicit.units === "1" ? raw(" checked") : ""}> ${L(lang, "اللي ليها وحدات بس", "Only projects with units")}</label>
    <button type="submit" class="secondary">${L(lang, "طبّق", "Apply")}</button>
  </form>
  <div class="rbar"><strong data-results-count>${stat}</strong>
    <span class="rsorts" data-results-sort>${SORTS.map(([k, ar, en]) => html`<a class="rsort${r.sort === k ? " on" : ""}" data-track="sort" data-detail="${k}" href="${link({ sort: k })}">${L(lang, ar, en)}</a>`)}</span></div>
  ${r.projects.map((g) => projectCard(lang, g))}
  ${r.pages > 1 ? html`<nav class="row" aria-label="${L(lang, "الصفحات", "Pages")}" data-results-pages data-track="page">${r.page > 1 ? html`<a class="pill" href="${link({ page: String(r.page - 1) })}">${L(lang, "السابق", "Previous")}</a>` : ""}${pageWindow(r.page, r.pages).map((p) => (p === null ? html`<span class="muted">…</span>` : html`<a class="pill${p === r.page ? " on" : ""}" href="${link({ page: String(p) })}">${p}</a>`))}${r.page < r.pages ? html`<a class="pill" href="${link({ page: String(r.page + 1) })}">${L(lang, "التالي", "Next")}</a>` : ""}</nav>` : ""}
  ${r.log_id ? html`<details class="card" data-wrong-results><summary>${L(lang, "النتايج دي غلط؟", "Wrong results?")}</summary>
    <form method="post" action="/app/ask/report" class="stack"><input type="hidden" name="sl" value="${r.log_id}"><label>${L(lang, "إيه الغلط؟ (اختياري)", "What is wrong? (optional)")} <input name="note" maxlength="500"></label>
    <button type="submit" class="secondary" data-report>${L(lang, "ابعت البلاغ", "Send the report")}</button></form></details>` : ""}
  ${state.trackSrc ? html`<script src="${state.trackSrc}" defer data-log="${r.log_id || ""}"></script>` : ""}
</section>`;
}

module.exports = { resultsView, pageWindow };
