// web/views/units.js — Unit fragments for the web, built from domain/describe.js (the one template)
"use strict";

const Describe = require("../../domain/describe");
const { html, phoneLtr, phoneOrText } = require("../html");
const { icon } = require("../icons");
const Delivery = require("../../domain/delivery");

/** The unit status buttons: [value, Arabic, English]. Same labels as the app. */
const UNIT_STATUS_BUTTONS = [["active", "متاحة", "Available"], ["sold", "اتباعت", "Sold"], ["archived", "أرشيف", "Archived"]];
/** The three status buttons as a form that posts one status (back = the page to return to). */
function statusForm(code, en, csrf, back = "") {
  const href = `/app/units/${encodeURIComponent(code)}`;
  return html`<form method="post" action="${href}/status" class="uc-actions" data-unit-status-row><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="back" value="${back}">${UNIT_STATUS_BUTTONS.map(([v, ar, enLabel]) => html`<button type="submit" name="status" value="${v}" class="secondary small" data-set-status="${v}">${en ? enLabel : ar}</button>`)}</form>`;
}
const stripMarkdown = (s) => String(s || "").replace(/[*`_]/g, "");

/** The web listing card with web controls for bulk selection, access and status. */
function resultItem(l, lang = "ar", { selectable = false, ask = null, back = "", badge = "", restore = false, thumb = null, mine = false, actions = null } = {}) {
  const en = lang === "en";
  // The place and its phase on the card: "Madinaty · B10".
  const place = en ? l.compound_en || l.details?.compound_en || l.compound : l.compound || l.compound_en;
  const phase = en ? l.phase_en : l.phase_ar;
  const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  // Keep the code in its own chip when the unit has a place or phase to use as the title.
  const title = [place, phase].filter((x, i, all) => x && !same(x, l.code) && !all.slice(0, i).some((y) => y && same(y, x))).join(" · ");
  const location = [l.district, l.city].filter((x, i, all) => x && !same(x, place || "") && !all.slice(0, i).some((y) => y && same(y, x))).join(" · ");
  const size = [
    Describe.bedsLabel(l, lang) && { ico: "🛏️", text: Describe.bedsLabel(l, lang) },
    Describe.bathsLabel(l, lang) && { ico: "🚿", text: Describe.bathsLabel(l, lang) },
    Describe.areaLabel(l, lang) && { ico: "📐", text: Describe.areaLabel(l, lang) }
  ].filter(Boolean);
  const price = stripMarkdown(Describe.priceLabel(l, lang));
  const delivery = Delivery.formatDelivery(l, lang);
  const pay = Describe.paymentHint(l, lang);
  const tags = Describe.featureLabels(l, lang);
  const finishing = Describe.finishingLabel(l, lang);
  const deal = l.listing_type === "sale" ? (en ? "For sale" : "للبيع") : l.listing_type === "rent" ? (en ? "For rent" : "للإيجار") : "";
  const dealClass = !badge && l.listing_type === "rent" ? "solid-rent" : "solid-primary";
  const property = l.property_type && Describe.TYPE_LABELS[String(l.property_type).toLowerCase()] ? Describe.typeLabel(l, lang) : "";
  const href = `/app/units/${encodeURIComponent(l.code)}`;
  // Review rows (the 21-day list) pass `actions` = { csrf, can(row), back }: the status buttons fold under a details block.
  const acts = actions && l.status !== "deleted" && actions.can(l) ? statusForm(l.code, en, actions.csrf, actions.back) : "";
  const body = html`${pay || delivery ? html`<ul class="tags">${pay ? html`<li>${stripMarkdown(pay)}</li>` : ""}${delivery ? html`<li class="chip good">${stripMarkdown(delivery)}</li>` : ""}</ul>` : ""}
    ${tags.length ? html`<ul class="uc-feat">${tags.map((t) => html`<li>${t}</li>`)}</ul>` : ""}`;
  return html`<li class="card result unitcard${selectable ? " inventory-unitcard" : ""}" data-code="${l.code}">
  ${selectable ? html`<input class="pick" type="checkbox" name="code" value="${l.code}" form="bulk" aria-label="${l.code}">` : ""}
  <a class="uc-main" href="${href}">
    <span class="uc-photo${thumb ? "" : " uc-no-photo"}">
      ${thumb ? html`<img class="uc-thumb" src="${thumb.thumb}" alt="" width="240" height="240" loading="lazy" decoding="async" data-full="${thumb.url}">` : icon("units", 28)}
      ${badge || deal ? html`<span class="uc-over-top"><span class="uc-pill ${dealClass}"${badge ? html` data-status-badge` : ""}>${badge || deal}</span></span>` : ""}
      <span class="uc-over-bottom"><span class="uc-pill solid-code"><bdi dir="ltr">${l.code}</bdi></span></span>
    </span>
    <span class="uc-info">
      ${property || finishing || mine ? html`<span class="uc-pills">
        ${property ? html`<span class="uc-pill tone-primary" data-property-type="${l.property_type}">${property}</span>` : ""}
        ${finishing ? html`<span class="uc-finishing">${finishing}</span>` : ""}
        ${mine ? html`<span class="uc-pill tone-accent">${en ? "Mine" : "بتاعتي"}</span>` : ""}
      </span>` : ""}
      <strong class="uc-title">${title || html`<bdi dir="ltr">${l.code}</bdi>`}</strong>
      ${location ? html`<span class="uc-sub">${icon("pin", 14)} ${location}</span>` : ""}
      ${size.length ? html`<span class="uc-size">${size.map((fact) => html`<span><span aria-hidden="true">${fact.ico}</span> ${stripMarkdown(fact.text)}</span>`)}</span>` : ""}
      ${price ? html`<b class="uc-price">${price}</b>` : ""}
    </span>
    <span class="uc-chev" aria-hidden="true">${icon("back", 16)}</span>
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
  return html`<ul class="facts">${lines.map((line) => {
    const contact = line.match(/^(📞 (?:Owner phone|تليفون المالك): |👤 (?:Owner|المالك): |🤝 (?:Co-broker|بروكر مشارك): )(.*)$/s);
    if (!contact) return html`<li>${line}</li>`;
    const [, label, value] = contact;
    return html`<li>${label}${label.startsWith("📞") ? phoneLtr(value) : phoneOrText(value)}</li>`;
  })}</ul>`;
}

module.exports = { stripMarkdown, resultItem, factList, statusForm };
