// web/views/units.js — Unit fragments for the web, built from domain/describe.js (the one template)
"use strict";

const Describe = require("../../domain/describe");
const { html } = require("../html");
const Delivery = require("../../domain/delivery");

/** The unit status buttons: [value, Arabic, English]. Same labels as the app. */
const UNIT_STATUS_BUTTONS = [["active", "متاحة", "Available"], ["sold", "اتباعت", "Sold"], ["archived", "أرشيف", "Archived"]];
/** The three status buttons as a form that posts one status (back = the page to return to). */
function statusForm(code, en, csrf, back = "") {
  const href = `/app/units/${encodeURIComponent(code)}`;
  return html`<form method="post" action="${href}/status" class="uc-actions" data-unit-status-row><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="back" value="${back}">${UNIT_STATUS_BUTTONS.map(([v, ar, enLabel]) => html`<button type="submit" name="status" value="${v}" class="secondary small" data-set-status="${v}">${en ? enLabel : ar}</button>`)}</form>`;
}
const stripMarkdown = (s) => String(s || "").replace(/[*`_]/g, "");

/** A unit card (search results, My units): code and price first, then size, payment and delivery as chips, and the
 * features on a copper strip. `selectable` adds a tick box for the bulk bar. */
function resultItem(l, lang = "ar", { selectable = false, ask = null, back = "", badge = "", restore = false, thumb = null, actions = null } = {}) {
  const en = lang === "en";
  // The place and its phase on the card: "Madinaty · B10".
  const place = en ? l.compound_en || l.details?.compound_en || l.compound : l.compound || l.compound_en;
  const phase = en ? l.phase_en : l.phase_ar;
  const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  // A part shown once: not twice, and not the code (the card already shows the code on top).
  const loc = [place, phase].filter((x, i, all) => x && !same(x, l.code) && all.findIndex((y) => same(y, x)) === i).join(" · ") || l.district;
  const size = [Describe.areaLabel(l, lang), Describe.bedsLabel(l, lang), Describe.bathsLabel(l, lang)].filter(Boolean).join(" · ");
  const delivery = Delivery.formatDelivery(l, lang);
  const pay = Describe.paymentHint(l, lang);
  const tags = Describe.featureLabels(l, lang);
  const href = `/app/units/${encodeURIComponent(l.code)}`;
  // Review rows (the 21-day list) pass `actions` = { csrf, can(row), back }: the status buttons fold under a details block.
  const acts = actions && l.status !== "deleted" && actions.can(l) ? statusForm(l.code, en, actions.csrf, actions.back) : "";
  const body = html`${pay || delivery ? html`<ul class="tags">${pay ? html`<li>${stripMarkdown(pay)}</li>` : ""}${delivery ? html`<li class="chip good">${stripMarkdown(delivery)}</li>` : ""}</ul>` : ""}
    ${tags.length ? html`<ul class="uc-feat">${tags.map((t) => html`<li>${t}</li>`)}</ul>` : ""}`;
  return html`<li class="card result unitcard" data-code="${l.code}">
  ${selectable ? html`<input class="pick" type="checkbox" name="code" value="${l.code}" form="bulk" aria-label="${l.code}">` : ""}
  <a class="uc-main${thumb ? " has-thumb" : ""}" href="${href}">
    ${thumb ? html`<img class="uc-thumb" src="${thumb.thumb}" alt="" loading="lazy" width="96" height="72" data-full="${thumb.url}">` : ""}
    <span class="uc-top"><b class="code" dir="ltr">${l.code}</b>${l.property_type && Describe.TYPE_LABELS[String(l.property_type).toLowerCase()] ? html` <span class="badge" data-property-type="${l.property_type}">${Describe.typeLabel(l, lang)}</span>` : ""}${l.listing_type === "rent" || l.listing_type === "sale" ? html` <span class="badge ${l.listing_type}" data-listing-type="${l.listing_type}">${l.listing_type === "rent" ? (en ? "Rent" : "إيجار") : (en ? "Sale" : "بيع")}</span>` : ""}${badge ? html` <span class="badge" data-status-badge>${badge}</span>` : ""}<b class="uc-price">${stripMarkdown(Describe.priceLabel(l, lang) || "")}</b></span>
    <span class="uc-sub">${[Describe.typeLabel(l, lang), l.listing_type === "rent" ? (en ? "For rent" : "للإيجار") : l.listing_type === "sale" ? (en ? "For sale" : "للبيع") : "", loc].filter(Boolean).join(" · ")}</span>
    ${size ? html`<span class="uc-size">${stripMarkdown(size)}</span>` : ""}
  </a>
  ${actions ? html`<details class="uc-more" data-unit-more><summary>${en ? "Details" : "التفاصيل"}</summary>${body}${acts}</details>` : body}
  ${restore ? html`<form method="post" action="/app/units/bulk" class="row"><input type="hidden" name="code" value="${l.code}"><input type="hidden" name="action" value="available"><button type="submit" class="secondary small" data-mark-available>🟢 ${en ? "Mark available again" : "رجّعها متاحة"}</button></form>` : ""}
  ${ask === "ask"
    ? html`<form method="post" action="${href}/access" class="row"><input type="hidden" name="back" value="${back}"><button type="submit" class="secondary small" data-ask-details>🔒 ${en ? "Ask for private details" : "اطلب البيانات الخاصة"}</button></form>`
    : ask === "pending"
      ? html`<p class="muted small" data-ask-pending>🔒 ${en ? "Requested. A manager will answer." : "اتطلبت. المدير هيرد."}</p>`
      : ""}
</li>`;
}

/** Every fact (and, for brokers, the internal lines) as a list. */
function factList(l, lang = "ar", { internal = true } = {}) {
  const lines = [...Describe.factLines(l, lang, { markMissing: internal }), ...(internal ? Describe.internalLines(l, lang) : [])].map(stripMarkdown);
  return html`<ul class="facts">${lines.map((x) => html`<li>${x}</li>`)}</ul>`;
}

module.exports = { stripMarkdown, resultItem, factList, statusForm };
