// web/views/catalogueList.js — The catalogue's list page: one search box (the unit box's suggestions: places and features, plus developers
// and projects) with chips and a few filters, then the matching projects as cards, then the developers.
"use strict";

const Features = require("../../domain/features");
const Describe = require("../../domain/describe");
const { html, raw } = require("../html");
const { ICON } = require("./unitForm");
const { projectCard } = require("./projectCard");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const STATUS = { launching: ["إطلاق جديد", "New launch"], selling: ["متاح", "Selling"], sold_out: ["اتباع", "Sold out"] };
const money = (n, lang) => {
  const v = Number(n);
  if (!(v > 0)) return null;
  const m = v / 1e6;
  const s = m >= 1 ? `${Number(m.toFixed(m >= 10 ? 1 : 2))}${L(lang, " مليون", "M")}` : `${Math.round(v / 1000)}${L(lang, " ألف", "K")}`;
  return `${s} ${L(lang, "ج.م", "EGP")}`;
};
const devName = (p, lang) => (lang === "en" ? p.developer_name_en || p.developer_name_ar : p.developer_name_ar || p.developer_name_en);
const bedText = (b, lang) => (b && b.length ? `${b.length > 1 ? `${Math.min(...b)}–${Math.max(...b)}` : b[0]} ${L(lang, "غرف", "bed")}` : null);

/** The query string of the search state, without one parameter (a chip's remove link) or with changes. */
function qs(state, drop = {}) {
  const u = new URLSearchParams();
  const s = { ...state, ...drop };
  for (const k of ["pq", "pl", "dev", "bed", "max"]) if (s[k]) u.set(k, s[k]);
  for (const f of s.f || []) u.append("f", f);
  if (s.archived) u.set("archived", "1");
  const t = u.toString();
  return t ? `?${t}` : "";
}

function chips(lang, state, labels) {
  const link = (cls, text, href, icon = "") => html`<a class="chip ${cls}" href="/app/catalogue${href}">${icon}<span>${text}</span><span class="chip-x" aria-label="${L(lang, "شيل", "Remove")}">${ICON.x}</span></a>`;
  return html`${state.pl ? link("chip-place", labels.place || "—", qs(state, { pl: "" }), ICON.pin) : ""}${(state.f || []).map((k) => link("chip-feature", Features.featureLabel(k, lang) || k, qs(state, { f: state.f.filter((x) => x !== k) })))}${state.dev ? link("chip-other", labels.developer || "—", qs(state, { dev: "" })) : ""}`;
}

/**
 * @param {Object} d - { projects, projPage, developers (all), devPage, state ({pq, pl, f[], dev, bed, max, archived}), labels ({place, developer}), dq, notice, manager, developerForm }
 */
function listPage(lang, d) {
  const { projects, projPage, devPage, state, labels, notice, manager, developerForm } = d;
  const filtered = Boolean(state.pq || state.pl || (state.f || []).length || state.dev || state.bed || state.max);
  const page = (n) => `${qs(state)}${qs(state) ? "&" : "?"}pp=${n}`;
  return html`<div class="uf-top"><h1>${L(lang, "كتالوج المطورين", "Developer catalogue")}</h1>
  <p class="row">${manager && !state.archived ? html`<a class="btn" href="/app/catalogue/projects/new" data-new-project>${L(lang, "مشروع جديد", "New project")}</a>` : ""}${manager ? html`<a class="btn secondary" href="/app/library">${L(lang, "مكتبة المشاريع", "Project library")}</a><a class="btn secondary" href="/app/catalogue/updates" data-quick-updates>${L(lang, "تحديث سريع", "Quick update")}</a>` : ""}<a class="btn secondary" href="/app/catalogue${state.archived ? "" : "?archived=1"}">${state.archived ? L(lang, "المشاريع الحالية", "Current projects") : L(lang, "المؤرشفة", "Archived")}</a></p></div>
${notice || ""}
<form method="get" action="/app/catalogue" class="card stack csearch" role="search" data-csearch data-url="/app/catalogue/search-box"
  data-msg-places="${L(lang, "الأماكن", "Places")}" data-msg-features="${L(lang, "المميزات", "Features")}" data-msg-developers="${L(lang, "المطورين", "Developers")}" data-msg-projects="${L(lang, "المشاريع", "Projects")}" data-msg-text="${L(lang, "ابحث عن «%s» في كل التفاصيل", "Search “%s” in every detail")}">
  <div class="ubox">
    <div class="ubox-field" data-csearch-field>
      ${chips(lang, state, labels)}
      <input type="search" class="ubox-input" name="pq" value="${state.pq || ""}" maxlength="80" autocomplete="off" data-csearch-input aria-label="${L(lang, "بحث", "Search")}" placeholder="${L(lang, "ابحث: مكان، ميزة، مطور، اسم مشروع…", "Search: a place, a feature, a developer, a project…")}">
    </div>
    <div class="ubox-list" data-csearch-list role="listbox" hidden></div>
  </div>
  ${state.pl ? html`<input type="hidden" name="pl" value="${state.pl}">` : ""}${(state.f || []).map((k) => html`<input type="hidden" name="f" value="${k}">`)}${state.dev ? html`<input type="hidden" name="dev" value="${state.dev}">` : ""}${state.archived ? html`<input type="hidden" name="archived" value="1">` : ""}
  <div class="row">
    <label>${L(lang, "الغرف", "Bedrooms")} <select name="bed"><option value="">—</option>${[1, 2, 3, 4, 5, 6].map((n) => html`<option value="${n}"${String(state.bed) === String(n) ? raw(" selected") : ""}>${n}</option>`)}</select></label>
    <label>${L(lang, "السعر لحد (ج.م)", "Price up to (EGP)")} <input name="max" inputmode="decimal" dir="ltr" size="10" value="${state.max || ""}" placeholder="5,000,000"></label>
    <button type="submit">${L(lang, "بحث", "Search")}</button>
    ${filtered ? html`<a class="btn secondary" href="/app/catalogue${state.archived ? "?archived=1" : ""}">${L(lang, "مسح البحث", "Clear")}</a>` : ""}
  </div>
</form>
<section class="stack" aria-label="${L(lang, "المشاريع", "Projects")}">
  <h2>${state.archived ? L(lang, "مؤرشفة", "Archived") : L(lang, "المشاريع", "Projects")} <span class="muted small">(${projPage.total_projects})</span></h2>
  ${projects.length ? html`<div class="pj-grid">${projects.map((p) => projectCard(lang, p, { browse: true }))}</div>` : html`<p class="card muted">${filtered ? L(lang, "مفيش مشروع بالبحث ده.", "No project matches this search.") : L(lang, "لسه مفيش مشاريع.", "No projects yet.")}</p>`}
  ${projPage.pages > 1 ? html`<nav class="row" aria-label="${L(lang, "صفحات المشاريع", "Project pages")}">${projPage.page > 1 ? html`<a href="/app/catalogue${page(projPage.page - 1)}">${L(lang, "السابق", "Previous")}</a>` : ""}<span class="muted">${projPage.page} / ${projPage.pages}</span>${projPage.page < projPage.pages ? html`<a href="/app/catalogue${page(projPage.page + 1)}">${L(lang, "التالي", "Next")}</a>` : ""}</nav>` : ""}
</section>
<section class="card stack">
  <h2>${L(lang, "المطورين", "Developers")}</h2>
  ${devPage.items.length
    ? html`<ul class="dev-list">${devPage.items.map((x) => html`<li data-developer="${x.id}"><a href="${qsDev(x.id)}">${x.name}</a>${x.name_en ? html` <span class="muted">${x.name_en}</span>` : ""} <span class="muted small">· ${x.projects} ${L(lang, "مشروع", "projects")}</span>${manager ? html` <a class="small" href="/app/catalogue/developers/${x.id}">${L(lang, "تعديل", "Edit")}</a>` : ""}</li>`)}</ul>
      ${devPage.pages > 1 ? html`<nav class="row" aria-label="${L(lang, "صفحات المطورين", "Developer pages")}">${devPage.page > 1 ? html`<a href="/app/catalogue?dp=${devPage.page - 1}">${L(lang, "السابق", "Previous")}</a>` : ""}<span class="muted">${devPage.page} / ${devPage.pages}</span>${devPage.page < devPage.pages ? html`<a href="/app/catalogue?dp=${devPage.page + 1}">${L(lang, "التالي", "Next")}</a>` : ""}</nav>` : ""}`
    : html`<p class="muted">${L(lang, "لسه مفيش مطورين. بيتضافوا وإنت بتضيف مشروع.", "No developers yet. They are added as you add a project.")}</p>`}
  ${manager ? html`<details><summary>${L(lang, "مطور جديد", "New developer")}</summary>${developerForm}</details>` : ""}
</section>`;
}
const qsDev = (id) => `/app/catalogue?dev=${id}`;

module.exports = { listPage, STATUS, money };
