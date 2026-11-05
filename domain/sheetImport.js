// domain/sheetImport.js — Inventory spreadsheet rows → listing fields (pure)
// Headers are matched in Arabic or English (including the agency export's own headers), wherever the
// header row is. Only the columns the sheet has are stated; a missing column never clears a field.
"use strict";

const Features = require("./features");
const Mixed = require("./sheetMixed");
const Delivery = require("./delivery");
const { TYPE_TERMS } = require("./vocabulary");
const { normalizeSearch } = require("./searchText");

// Checked in order: the first match wins (e.g. "owner phone" before "owner").
const COLUMNS = [
  ["code", /^(code|unit code|unit id|ref|كود|الكود|كود الوحده|الكود الداخلي)$/],
  ["owner_phone", /(owner phone|owner mobile|تليفون المالك|رقم المالك|موبايل المالك)/],
  ["owner_phone", /^(number|phone|phone number|mobile|tel|telephone|رقم التليفون|رقم الموبايل|تليفون|موبايل)$/],
  ["owner_name", /^(owner|owner name|name|المالك|اسم المالك|الاسم|اسم)$/],
  ["unit_no", /^(unit no|unit number|unit num|apartment no|رقم الوحده|رقم الوحدة|رقم الشقه|رقم الشقة)$/],
  ["address", /^(address|full address|location|unit location|العنوان بالكامل|العنوان التفصيلي|العنوان بالتفصيل|الموقع)$/],
  ["details_text", /^(details|detail|تفاصيل|التفاصيل)$/],
  ["land_area", /^(land|land area|مساحه الارض|مساحه ارض|الارض)$/],
  ["summary_en", /^summary/],
  ["description", /(description|الوصف|وصف)/],
  ["title", /^(title|العنوان)$/],
  ["compound", /(compound|project|الكمبوند|كمبوند|المشروع)/],
  ["market", /(market|inventory|السوق|نوع المخزون)/],
  ["property_type", /^(property type|type|unit type|نوع|النوع|نوع العقار|نوع الوحده)$/],
  ["listing_type", /^(purpose|sale rent|sale or rent|بيع او ايجار|بيع ايجار|الغرض)$/],
  ["remaining_amount", /(remaining|المتبقي)/],
  ["down_payment_value", /(upfront cash|cash paid|paid|down payment|المدفوع|المقدم|مقدم)/],
  ["installment_value", /(quarterly check|installment amount|installment|قيمه القسط|القسط)/],
  ["payment_frequency", /(frequency|دوريه القسط)/],
  ["installment_years", /(tenure|years|سنوات|سنين)/],
  ["price_value", /^(price|total price|asking price|السعر|سعر|اجمالي السعر|السعر الاجمالي)( egp)?$/],
  ["area_value", /^(area|area sqm|bua|المساحه|مساحه|المساحه م2|المساحه بالمتر)/],
  ["bedrooms", /(bedrooms|beds|غرف|الغرف)/],
  ["bathrooms", /(bathrooms|baths|حمامات|الحمامات)/],
  ["floor", /^(floor|الدور|دور)$/],
  ["delivery", /(delivery|التسليم|الاستلام|استلام)/],
  ["finishing", /(finishing|التشطيب|تشطيب)/],
  ["orientation", /(orientation|الواجهه|واجهه)/],
  ["features", /(amenities|features|extras|المميزات|مميزات)/],
  ["district", /(district|city|area name|المنطقه|الحي|المدينه)/],
  ["status", /^(status|الحاله)$/],
  ["notes", /(notes|feedback|ملاحظات|فيدباك)/]
];

// A header with a typo ("descibation", "deatils") is still the column it was meant to be.
const FUZZY = [["description", "description"], ["details", "details_text"], ["bedrooms", "bedrooms"], ["bathrooms", "bathrooms"], ["location", "address"], ["compound", "compound"], ["price", "price_value"], ["phone", "owner_phone"], ["feedback", "notes"]];
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function fuzzyColumn(h) {
  if (!/^[a-z]{5,14}$/.test(h)) return null;
  for (const [word, key] of FUZZY) if (Math.abs(word.length - h.length) <= 2 && editDistance(word, h) <= (word.length >= 10 ? 3 : word.length >= 7 ? 2 : 1)) return key;
  return null;
}

/** Header text → field key (or null). */
function columnFor(header) {
  const h = normalizeSearch(header);
  if (!h) return null;
  for (const [key, re] of COLUMNS) if (re.test(h)) return key;
  return fuzzyColumn(h);
}

const EMPTY = new Set(["", "-", "—", "n/a", "na", "null", "none", "لا يوجد"]);
// A leading apostrophe is the export's formula-injection guard (lib/excel.js sanitizeCellValue), not data.
const isEmpty = (v) => v === null || v === undefined || EMPTY.has(String(v).trim().replace(/^'+/, "").toLowerCase());
const text = (v, max = 200) => (isEmpty(v) ? null : String(v).trim().replace(/^'+/, "").slice(0, max));
const unquote = (v) => (typeof v === "string" ? v.trim().replace(/^'+/, "") : v);
const AR = "٠١٢٣٤٥٦٧٨٩";
const digits = (s) => String(s).replace(/[٠-٩]/g, (d) => String(AR.indexOf(d)));

/** "8.5 مليون", "8,500,000", "8.5M", 8500000 → 8500000; 0 and unknown → null. */
function money(v) {
  if (isEmpty(v)) return null;
  if (typeof v === "number") return v > 0 ? v : null;
  const s = digits(v).toLowerCase().replace(/egp|le|ج\.?م|جنيه/g, "").trim();
  const m = s.match(/^([\d.,]+)\s*(m|mn|million|مليون|k|الف|ألف|thousand)?$/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] || "";
  return /^(m|mn|million|مليون)$/.test(unit) ? Math.round(n * 1e6) : /^(k|الف|ألف|thousand)$/.test(unit) ? Math.round(n * 1e3) : n;
}
const number = (v) => {
  if (isEmpty(v)) return null;
  const n = typeof v === "number" ? v : Number(digits(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const positive = (v) => {
  const n = number(v);
  return n !== null && n > 0 ? n : null;
};

const CURRENCY = /(\$|usd|€|eur\b|dollar|دولار|يورو)/i;

/** Columns a sheet must fill for any row to be usable; a tab with one of these empty across every row is refused. */
const REQUIRED = ["code", "price_value", "area_value"];

/** Required columns with no value on any row (rows: [{ cells }]). A tab with no rows reports nothing. */
function emptyRequired(rows = []) {
  if (!rows.length) return [];
  return REQUIRED.filter((k) => !rows.some((r) => r.cells && !isEmpty(r.cells[k])));
}

const TYPE_LOOKUP = new Map(
  Object.entries({ ...TYPE_TERMS, villa: [...TYPE_TERMS.villa, "standalone villa"] }).flatMap(([key, words]) => words.map((w) => [normalizeSearch(w), key]))
);
const TYPE_WORDS = [["apartment", "apartment"], ["penthouse", "penthouse"], ["townhouse", "townhouse"], ["twinhouse", "twinhouse"], ["standalone", "villa"], ["duplex", "duplex"], ["studio", "studio"], ["chalet", "chalet"], ["triplex", "triplex"], ["basement", "basement"], ["mazonette", "mazonette"], ["maisonette", "maisonette"], ["skyloft", "sky_loft"]];
/** Garden anywhere in the type cell ("apartment with garden", "ground with garden"): the unit gets the private-garden feature. */
const gardenIn = (v) => /garden/.test(normalizeSearch(v));
/** Words after a type that say where the unit is or what it has ("apartment 4th floor", "town house corner", "studio with roof"). */
const TYPE_NOISE = /\b(ground|floor|corner|middle|roof|with|without|garden|first|use|type|single|and|for|both|[a-e]|\d+\w{0,2})\b/g;
/** The type a normalized text names: an exact term, else a term it contains. */
function typeIn(t) {
  if (TYPE_LOOKUP.has(t)) return TYPE_LOOKUP.get(t);
  for (const [w, key] of TYPE_LOOKUP) if (w.length >= 4 && t.includes(w)) return key;
  return null;
}
function propertyType(v) {
  const t = normalizeSearch(v);
  if (!t) return null;
  const direct = typeIn(t);
  if (direct) return direct;
  const core = t.replace(TYPE_NOISE, " ").replace(/\s+/g, " ").trim();
  const fromCore = core && core !== t ? typeIn(core) : null;
  if (fromCore) return fromCore;
  // A typo ("apatment", "apaerment(cleo)", "twon house") is still the type it was meant to be.
  for (const text of [t, core]) {
    const words = text.split(/[\s,/()]+/).map((x) => x.replace(/[^a-z]/g, "")).filter(Boolean);
    for (const word of [words[0], words.slice(0, 2).join("")].filter((x) => x && /^[a-z]{6,12}$/.test(x))) {
      for (const [w, key] of TYPE_WORDS) if (editDistance(w, word) <= (w.length >= 8 ? 2 : 1)) return key;
    }
  }
  return null;
}

const FINISHING = [
  ["ultra_super_lux", /(ultra|الترا)/],
  ["super_lux", /(super ?lux|سوبر لوكس)/],
  ["semi_finished", /(semi|نص تشطيب|نصف تشطيب)/],
  ["core_and_shell", /(core|shell|بدون تشطيب|طوب احمر|خرسانه)/],
  ["fully_finished", /(fully|full|finished|تشطيب كامل|متشطب|كامل التشطيب|لوكس)/]
];
const finishing = (v) => {
  const t = normalizeSearch(v);
  return t ? FINISHING.find(([, re]) => re.test(t))?.[0] || null : null;
};
const listingType = (v) => {
  const t = normalizeSearch(v);
  return /(rent|ايجار)/.test(t) ? "rent" : /(sale|بيع)/.test(t) ? "sale" : null;
};
const market = (v) => {
  const t = normalizeSearch(v);
  return /(primary|developer|برايمري|مطور)/.test(t) ? "primary" : /(resale|ريسيل|اعاده بيع)/.test(t) ? "resale" : null;
};
// Words that say a unit is gone: rented or sold (status "sold" is used for both) or no longer available (archived).
const GONE_WORDS = /(\bsold\b|\brented\b|\bleased\b|مباع|اتباع|اتأجر|اتاجر|مؤجر|مأجر|متأجر|متاجر|ايجار منتهي)/;
const CLOSED_WORDS = /(not available|unavailable|\bclosed\b|off market|مش متاح|غير متاح|مغلق|مقفول)/;
const status = (v) => {
  const t = normalizeSearch(v);
  return GONE_WORDS.test(t) ? "sold" : CLOSED_WORDS.test(t) || /(archiv|مؤرشف|مورشف|ارشيف)/.test(t) ? "archived" : /(active|available|متاح|نشط)/.test(t) ? "active" : null;
};

/** A unit status the notes state ("rented", "مباع", "not available"), for the one-time confirmation; null when they say nothing. */
function statusHint(cells) {
  if (cells.status !== undefined && cells.status !== null && String(cells.status).trim() !== "") return null;
  for (const k of ["notes", "details_text"]) {
    const t = normalizeSearch(cells[k]);
    if (!t) continue;
    if (GONE_WORDS.test(t)) return "sold";
    if (CLOSED_WORDS.test(t)) return "archived";
  }
  return null;
}

/** A delivery cell that Excel stored as a date (a serial number like 45567) → "10/2026"; anything else unchanged. */
function deliveryCell(v) {
  const n = typeof v === "number" ? v : /^\d{5}$/.test(String(v).trim()) ? Number(v) : NaN;
  if (!(n >= 40000 && n <= 60000)) return v;
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
  return `${d.getUTCMonth() + 1}/${d.getUTCFullYear()}`;
}
const FREQ = [["semi_annual", /(semi|نص سنوي|نصف سنوي)/], ["quarterly", /(quarter|ربع)/], ["monthly", /(month|شهري)/], ["annual", /(annual|year|سنوي)/]];
const frequency = (v) => {
  const t = normalizeSearch(v);
  return t ? FREQ.find(([, re]) => re.test(t))?.[0] || null : null;
};

/** "1001222400/ 1275615557", "+20 100 123 4567", "971551040978-" → { first, more } with Egyptian mobiles in their 01… form. */
function phones(v) {
  const list = String(digits(v))
    .split(/[\/\\,;،|\n]+|\s{2,}|\s+-\s+/)
    .map((x) => x.replace(/[^\d+]/g, "").replace(/^\+/, "").replace(/\+/g, ""))
    .filter((x) => x.length >= 8)
    .map((x) => (/^20(1\d{9})$/.test(x) ? "0" + x.slice(2) : /^1\d{9}$/.test(x) ? "0" + x : x));
  return { first: list[0] || null, more: list.slice(1) };
}

const LONG_TEXT = ["description", "details_text", "notes", "summary_en", "title"];

/**
 * Cells that hold several facts: the price with words around it, the area with land and built-up together, and the
 * free texts that state rooms, areas or a price. Only fields the row leaves empty are filled; a stated cell wins.
 * @returns {{ cells: Object, derived: string[], errors: string[] }}
 */
function expand(input) {
  const cells = { ...input };
  const derived = [];
  const errors = [];
  const extra = [];
  const blank = (k) => !(k in cells) || isEmpty(cells[k]);
  const put = (k, v) => {
    if (v !== undefined && v !== null && blank(k)) {
      cells[k] = v;
      derived.push(k);
    }
  };

  if (!blank("price_value") && !CURRENCY.test(String(cells.price_value)) && money(cells.price_value) === null) {
    const p = Mixed.priceText(cells.price_value);
    if (p?.ambiguous) errors.push("price_value");
    else if (p?.price_value) {
      extra.push(String(cells.price_value).trim());
      cells.price_value = p.price_value;
    }
  }
  if (!blank("area_value") && typeof cells.area_value === "string" && /[a-zA-Z\u0600-\u06FF]/.test(cells.area_value)) {
    const a = Mixed.areas(cells.area_value);
    if (a.area_value || a.land_area) {
      if (a.land_area) extra.push(String(cells.area_value).trim());
      if (a.area_value) cells.area_value = a.area_value;
      else delete cells.area_value;
      if (a.land_area) put("land_area", a.land_area);
    }
  }
  for (const k of LONG_TEXT) {
    if (blank(k)) continue;
    const r = Mixed.readText(cells[k]);
    for (const f of ["bedrooms", "bathrooms", "area_value", "land_area", "price_value"]) put(f, r[f]);
  }
  if (!blank("details_text")) extra.unshift(String(cells.details_text).trim());
  if (extra.length) cells.notes = [cells.notes, ...extra].filter((x) => !isEmpty(x)).map(String).join(" · ");
  return { cells, derived, errors };
}

/**
 * One sheet row → { code, status, draft } where draft has the normalizeExtraction shape with only the
 * stated fields; errors lists what could not be read.
 * @param {Object} cells - field key → raw cell value
 */
function rowToDraft(input = {}) {
  const expanded = expand(Object.fromEntries(Object.entries(input).map(([k, v]) => [k, unquote(v)])));
  const cells = expanded.cells;
  const draft = { details: {} };
  const errors = [...expanded.errors];
  const has = (k) => k in cells && !isEmpty(cells[k]);
  const code = has("code") ? digits(String(cells.code)).replace(/\s+/g, "").toUpperCase().replace(/^#/, "") : null;
  if (code && !/^[A-Z0-9][A-Z0-9_\-./]{1,29}$/.test(code)) errors.push("code");

  if (has("compound")) draft.compound = text(cells.compound, 120);
  if (has("title")) draft.title = text(cells.title);
  if (has("district")) draft.district = text(cells.district, 120);
  if (has("property_type")) {
    draft.property_type = propertyType(cells.property_type);
    if (!draft.property_type) errors.push("property_type");
  }
  if (has("listing_type")) draft.listing_type = listingType(cells.listing_type);
  if (has("market")) draft.market = market(cells.market);
  for (const k of ["price_value", "down_payment_value", "remaining_amount", "installment_value"]) {
    if (has(k)) {
      // A price in dollars or euros is not guessed at: the row is held back until someone fixes the cell.
      if (CURRENCY.test(String(cells[k]))) {
        if (k === "price_value") errors.push("currency");
        continue;
      }
      draft[k] = money(cells[k]);
      if (draft[k] === null && k === "price_value") errors.push(k);
    }
  }
  if (has("area_value")) {
    draft.area_value = positive(cells.area_value);
    if (!draft.area_value) errors.push("area_value");
  }
  for (const k of ["bedrooms", "bathrooms", "installment_years"]) {
    if (has(k)) {
      const n = number(cells[k]);
      draft[k] = n === null ? null : Math.round(n);
      if (k === "installment_years" && !draft[k]) delete draft[k];
    }
  }
  if (has("payment_frequency")) draft.payment_frequency = frequency(cells.payment_frequency);
  if (has("floor")) {
    const f = String(cells.floor).trim();
    const n = number(f);
    if (/^(ground|ارضي|أرضي|الارضي)$/i.test(f)) draft.floor_level = 0;
    else if (n !== null && /^\D*\d+\D*$/.test(digits(f))) draft.floor_level = Math.round(n);
    else draft.details.floor = text(f, 40);
  }
  if (has("delivery")) Object.assign(draft, Delivery.parseDelivery(text(deliveryCell(cells.delivery), 60)));
  if (has("finishing")) draft.finishing = finishing(cells.finishing);
  if (has("features") || has("orientation")) {
    const words = [cells.features, cells.orientation]
      .filter((x) => !isEmpty(x))
      .flatMap((x) => String(x).split(/[•,،\/|\n;]+/))
      .map((x) => x.trim())
      .filter(Boolean);
    const { keys, other } = Features.classifyFeatures(words);
    draft.feature_keys = keys;
    draft.features_other = other;
  }
  if (has("property_type") && gardenIn(cells.property_type)) draft.feature_keys = [...new Set([...(draft.feature_keys || []), "private_garden"])];
  // A description that states the finishing or features ("fully finished / kitchen / ACs") is read with the app's own
  // vocabulary, but only when the sheet has no column for them; a stated column always wins.
  if (has("description") && !has("features") && !has("orientation")) {
    const { keys } = Features.classifyFeatures(String(cells.description).split(/[•,،\/|\\\n;+]+/).map((x) => x.trim()).filter(Boolean));
    if (keys.length) draft.feature_keys = keys;
  }
  if (has("description") && !has("finishing") && /(finish|lux|تشطيب|لوكس)/i.test(String(cells.description))) {
    const f = finishing(cells.description);
    if (f) draft.finishing = f;
  }
  if (has("description")) draft.details.clean_summary = text(cells.description, 600);
  if (has("summary_en")) draft.details.summary_en = text(cells.summary_en, 600);
  if (has("owner_name")) draft.details.owner_name = text(cells.owner_name, 120);
  if (has("unit_no")) draft.details.unit_no = text(cells.unit_no, 40);
  if (has("address")) draft.details.address = text(cells.address, 200);
  if (has("owner_phone")) {
    const ph = phones(cells.owner_phone);
    draft.details.owner_phone = ph.first ? text(ph.first, 40) : text(digits(cells.owner_phone), 40);
    if (ph.more.length) draft.details.notes = [draft.details.notes, `${ph.more.join(" / ")}`].filter(Boolean).join(" · ");
  }
  if (has("land_area")) {
    const land = positive(cells.land_area);
    if (land) draft.details.land_area = land;
  }
  if (has("notes")) draft.details.notes = [text(cells.notes, 1000), draft.details.notes].filter(Boolean).join(" · ") || null;
  for (const k of Object.keys(draft)) if (draft[k] === null || draft[k] === undefined) delete draft[k];
  for (const k of Object.keys(draft.details)) if (draft.details[k] === null) delete draft.details[k];
  return { code, status: has("status") ? status(cells.status) : null, draft, errors: [...new Set(errors)], derived: expanded.derived };
}

module.exports = { statusHint, deliveryCell, COLUMNS, REQUIRED, columnFor, rowToDraft, emptyRequired, money, propertyType, finishing, CURRENCY };
