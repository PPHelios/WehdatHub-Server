// web/views/projectCard.js — The one project card, shared by Ask's results and the catalogue list (and shaped like the app's): a cover (photo, or a
// tinted placeholder) with the status, the name and who/where, three key figures (price from, bedrooms, down payment and term), a quiet line of the rest
// (size, types, delivery), why it is listed ("Matches: place, features"), then the fitting units, or its free text, or a note that no unit details are
// recorded; in browse mode (the catalogue list) the counts instead. Data: services/projectSearch.js card().
"use strict";

const { html, raw } = require("../html");

const { L } = require("../../lib/copy");
const money = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
/** 3,500,000 → "3.5M"; 850,000 → "850K". */
const short = (n, lang) => {
  const v = Number(n);
  if (!(v > 0)) return "—";
  if (v >= 1e6) return `${Number((v / 1e6).toFixed(v >= 1e7 ? 1 : 2))}${L(lang, " مليون", "M")}`;
  return `${Math.round(v / 1000)}${L(lang, " ألف", "K")}`;
};
const STATUS = { launching: ["إطلاق جديد", "New launch"], selling: ["متاح", "Selling"], sold_out: ["اتباع", "Sold out"] };
const MATCH = {
  place: ["المكان", "place"], features: ["المميزات", "features"], developer: ["المطور", "developer"], price: ["السعر", "price"], area: ["المساحة", "area"],
  bedrooms: ["الغرف", "bedrooms"], down: ["المقدم", "down payment"], installment: ["القسط", "installment"]
};
const BUILDING = raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16M14 9h5a1 1 0 0 1 1 1v11M3 21h18M8 8h2M8 12h2M8 16h2M17 13h1M17 17h1"/></svg>');

const range = (b) => (b && b.length ? (b.length > 1 ? `${Math.min(...b)}–${Math.max(...b)}` : String(b[0])) : null);

/** @param {{ browse?: boolean, send?: boolean }} opts browse = the catalogue list (counts, no units table); send = the "send to a client" button (results) */
function projectCard(lang, g, { browse = false, send = !browse } = {}) {
  const name = lang === "en" ? g.name_en || g.name : g.name;
  const open = `/app/catalogue/projects/${g.id}`;
  const s = g.stats || {};
  const stats = [
    [L(lang, "يبدأ من", "From"), g.price_from != null ? short(g.price_from, lang) : null, g.price_from != null ? L(lang, "جنيه", "EGP") : null],
    [L(lang, "الغرف", "Bedrooms"), range(s.bedrooms), null],
    [L(lang, "المقدم", "Down"), s.down_pct != null ? `${s.down_pct}%` : null, s.years ? `${s.years} ${L(lang, "سنين", "yrs")}` : null]
  ].filter((x) => x[1]);
  const quiet = [s.acres ? `${s.acres} ${L(lang, "فدان", "feddan")}` : null, (s.types || []).join(" · ") || null, g.delivery ? `${L(lang, "الاستلام", "Delivery")} ${g.delivery}` : null].filter(Boolean);
  const place = [g.place, g.governorate].filter(Boolean).join(" · ");
  const counts = browse
    ? [g.offers_count ? `${g.offers_count} ${L(lang, "عرض وحدات", "unit offers")}` : null, g.units ? `${g.units} ${L(lang, "وحدة", "units")}` : null, g.plans ? `${g.plans} ${L(lang, "نظام سداد", "plans")}` : null].filter(Boolean).join(" · ") || L(lang, "مفيش تفاصيل وحدات لسه", "No unit details yet")
    : "";
  return html`<article class="card pj-card${browse ? " pj-browse" : ""}" data-ask-project="${g.id}" data-project="${g.id}">
  <a class="pj-cover${g.cover_url ? "" : " pj-empty"}" href="${open}" data-track="open" data-detail="${g.id}" aria-label="${name}">
    ${g.cover_url ? html`<img src="${g.cover_url}" alt="" loading="lazy">` : html`<span class="pj-none">${BUILDING}</span>`}
    ${STATUS[g.status] ? html`<span class="pj-badge pj-${g.status}">${STATUS[g.status][lang === "en" ? 1 : 0]}</span>` : ""}
    ${g.discount_pct ? html`<span class="pj-deal">${g.discount_pct}% ${L(lang, "خصم", "off")}</span>` : ""}
  </a>
  <div class="pj-body">
    <div class="pj-title"><a href="${open}" data-track="open" data-detail="${g.id}">${name}</a>
      <div class="pj-sub">${[g.developer, place].filter(Boolean).join(" · ") || "—"}</div></div>
    ${stats.length ? html`<dl class="pj-stats">${stats.map(([k, v, u]) => html`<div><dt>${k}</dt><dd>${v}${u ? html` <small>${u}</small>` : ""}</dd></div>`)}</dl>` : ""}
    ${quiet.length ? html`<p class="pj-quiet">${quiet.join("  ·  ")}</p>` : ""}
    ${!browse && g.matched && g.matched.length ? html`<p class="pj-match" data-matched>${L(lang, "مناسب في", "Matches")}: ${g.matched.map((k) => MATCH[k][lang === "en" ? 1 : 0]).join(L(lang, "، ", ", "))}</p>` : ""}
    ${browse
      ? html`<p class="pj-counts" data-counts>${counts}</p>`
      : g.offers.length
        ? html`<div class="scroll"><table data-project-offers><thead><tr><th>${L(lang, "الوحدة", "Unit")}</th><th>${L(lang, "المساحة", "Area")}</th><th>${L(lang, "السعر", "Price")}</th><th>${L(lang, "المقدم", "Down")}</th><th>${L(lang, "القسط", "Monthly")}</th></tr></thead>
        <tbody>${g.offers.map((u) => html`<tr><td>${[u.type, u.bedrooms != null ? `${u.bedrooms} ${L(lang, "غرف", "bed")}` : null, u.floor ? `${L(lang, "الدور", "floor")} ${u.floor}` : null].filter(Boolean).join(" · ") || "—"}</td><td dir="ltr">${u.area != null ? `${u.area} m²` : L(lang, "مش مكتوبة", "not written")}</td><td dir="ltr"><strong>${money(u.price)}</strong></td><td dir="ltr">${money(u.down)}</td><td dir="ltr">${u.monthly != null ? `${money(u.monthly)}${u.years ? ` × ${u.years}y` : ""}` : "—"}</td></tr>`)}</tbody></table></div>
        ${g.offers_total > g.offers.length ? html`<p class="pj-counts">+ ${g.offers_total - g.offers.length} ${L(lang, "اختيارات تانية", "more options")} · <a href="${open}">${L(lang, "افتح المشروع", "Open the project")}</a></p>` : ""}`
        : g.free_text
          ? html`<p class="pre pj-free" data-project-free-text>${g.free_text}</p>`
          : html`<p class="pj-counts" data-project-no-details>${L(lang, "مفيش تفاصيل وحدات مسجلة للمشروع ده لسه.", "No unit details are recorded for this project yet.")}</p>`}
    ${send ? html`<div class="pj-actions"><a class="btn" data-track="send" data-detail="${g.id}" href="https://wa.me/?text=${encodeURIComponent(g.client_text)}" target="_blank" rel="noopener noreferrer">${L(lang, "ابعت لعميل", "Send to a client")}</a><a class="btn secondary" data-track="open" data-detail="${g.id}" href="${open}">${L(lang, "افتح المشروع", "Open")}</a></div>` : ""}
  </div></article>`;
}

module.exports = { projectCard, STATUS };
