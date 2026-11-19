// web/views/importEditor.js — The structured editor of one imported unit (WhatsApp import): the same controls as the add/edit
// unit form (place search with chips, sale/rent chips, dropdowns for type, finishing and furnishing), so what is typed stays
// standard. One partial, used by the review page's Edit window and by the pre-upload Edit window. The form it sits in posts
// `c_<cell>` fields plus the unit box's own `compound`, `feature` and `features_other`; cellsFromForm turns those back into cells.
"use strict";

const Describe = require("../../domain/describe");
const Features = require("../../domain/features");
const Rules = require("../../domain/fieldRules");
const { html, raw } = require("../html");
const { unitBox } = require("./unitForm");
const { cellsFromForm, boxValues, MANAGED } = require("../../domain/importEditorCells");

const { L } = require("../../lib/copy");
const pick = (pair, lang) => (pair ? (lang === "en" ? pair[1] : pair[0]) : "");

const FURNISHING = [["furnished", ["مفروشة", "Furnished"]], ["semi_furnished", ["نصف فرش", "Semi-furnished"]], ["unfurnished", ["بدون فرش", "Unfurnished"]], ["kitchen_and_ac", ["مطبخ وتكييف", "Kitchen and AC"]]];

/**
 * @param {{ cells: object, areas: object[], place: object|null, lang: string, missing?: string[] }} p
 * `missing`: cells the plan could not do without: outlined in red.
 */
function importEditor({ cells = {}, areas = [], place = null, lang = "ar", missing = [] }) {
  const need = new Set(missing);
  const v = (k) => String(cells[k] ?? "");
  const lab = (text, key, star) => html`<span class="ie-label">${text}${star ? " *" : ""}</span>`;
  const wrap = (key, star) => `ie-field${need.has(key) ? " missing" : ""}${star ? " req" : ""}`;
  const input = (key, label, { star = false, type = "text", extra = "", dir = null } = {}) =>
    html`<label class="${wrap(key, star)}" data-field="${key}">${lab(label, key, star)}<input name="c_${key}" type="${type}" value="${v(key)}"${dir ? html` dir="${dir}"` : ""}${raw(extra)}></label>`;
  const select = (key, label, options, { star = false } = {}) =>
    html`<label class="${wrap(key, star)}" data-field="${key}">${lab(label, key, star)}<select name="c_${key}"><option value="">—</option>${options.map(([val, text]) => html`<option value="${val}"${v(key) === val ? raw(" selected") : ""}>${text}</option>`)}</select></label>`;
  const purpose = v("listing_type");
  const sec = (icon, title, body, extraClass = "") => html`<section class="ie-section${extraClass}"><h3 class="ie-title"><span aria-hidden="true">${icon}</span> ${title}</h3>${body}</section>`;
  const paymentOpen = v("down_payment_value") || v("remaining_amount") || v("installment_value") || v("owner_name") || v("owner_phone") || need.has("owner_phone");
  return html`<div class="ie stack" data-importeditor>
  ${sec("📍", L(lang, "المكان والمميزات", "Place and features"), html`<div class="ie-block${need.has("compound") ? " missing" : ""}" data-field="compound">
    ${need.has("compound") ? html`<em class="ie-miss">⚠️ ${L(lang, "ناقص: اختار الكمبوند أو المنطقة", "Missing: pick the compound or area")}</em>` : ""}
    ${unitBox(boxValues(cells), areas, lang, place, {})}</div>`)}
  ${sec("🏷️", L(lang, "الصفقة", "Deal"), html`<div class="ie-block${need.has("listing_type") ? " missing" : ""}" data-field="listing_type">
    <span class="ie-label">${L(lang, "بيع أو إيجار", "Sale or rent")} *${need.has("listing_type") ? html` <em class="ie-miss">⚠️ ${L(lang, "ناقص", "Missing")}</em>` : ""}</span>
    <div class="ie-seg" role="radiogroup" aria-label="${L(lang, "بيع أو إيجار", "Sale or rent")}">
      <label><input type="radio" name="c_listing_type" value="sale"${purpose === "sale" ? raw(" checked") : ""}><span>🏠 ${L(lang, "بيع", "Sale")}</span></label>
      <label><input type="radio" name="c_listing_type" value="rent"${purpose === "rent" ? raw(" checked") : ""}><span>🔑 ${L(lang, "إيجار", "Rent")}</span></label>
    </div></div>
    <div class="ie-grid">
      ${select("property_type", L(lang, "النوع", "Type"), Rules.PROPERTY_TYPES.map((t) => [t, pick(Describe.TYPE_LABELS[t], lang)]), { star: true })}
      ${input("price_value", purpose === "rent" ? L(lang, "الإيجار", "Rent") : L(lang, "السعر", "Price"), { star: true, extra: ` inputmode="decimal" data-money placeholder="${L(lang, "8.5 مليون", "8.5M")}"` })}
    </div>`)}
  ${sec("📐", L(lang, "المساحة والغرف", "Size and rooms"), html`<div class="ie-grid">
    ${input("area_value", L(lang, "المساحة م² (المباني للفيلات)", "Area m² (BUA for villas)"), { star: true, type: "number", extra: ' min="0" step="any"' })}
    ${input("land_area", L(lang, "مساحة الأرض م²", "Land area m²"), { type: "number", extra: ' min="0" step="any"' })}
    ${input("bedrooms", L(lang, "الغرف", "Bedrooms"), { star: need.has("bedrooms") || ["apartment", "villa"].includes(Rules.unitKind(v("property_type"))), type: "number", extra: ' min="0"' })}
    ${input("bathrooms", L(lang, "الحمامات", "Bathrooms"), { type: "number", extra: ' min="0"' })}
    ${input("floor", L(lang, "الدور (0 = أرضي)", "Floor (0 = ground)"))}
  </div>`)}
  ${sec("🛋️", L(lang, "التشطيب والفرش", "Finishing and furnishing"), html`<div class="ie-grid">
    ${select("finishing", L(lang, "التشطيب", "Finishing"), Object.entries(Describe.FINISHING_LABELS).map(([k, p]) => [k, pick(p, lang)]))}
    ${select("furnishing", L(lang, "الفرش", "Furnishing"), FURNISHING.map(([k, p]) => [k, pick(p, lang)]))}
    ${input("delivery", L(lang, "التسليم", "Delivery"))}
  </div>`)}
  <details class="ie-section ie-more"${paymentOpen ? raw(" open") : ""}><summary class="ie-title"><span aria-hidden="true">💳</span> ${L(lang, "الدفع والمالك", "Payment and owner")}${need.has("owner_phone") ? html` <em class="ie-miss">⚠️ ${L(lang, "تليفون المالك ناقص", "Owner phone missing")}</em>` : ""}</summary>
    <div class="ie-grid">
      ${input("down_payment_value", L(lang, "المقدم", "Down payment"))}
      ${input("remaining_amount", L(lang, "المتبقي", "Remaining"))}
      ${input("installment_value", L(lang, "القسط", "Installment"))}
      ${input("owner_name", L(lang, "اسم المالك", "Owner name"))}
      ${input("owner_phone", L(lang, "تليفون المالك", "Owner phone"), { star: true, dir: "ltr", extra: ' inputmode="tel" placeholder="01012345678"' })}
    </div></details>
</div>`;
}

module.exports = { importEditor, cellsFromForm, boxValues, MANAGED };
