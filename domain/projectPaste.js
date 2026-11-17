// domain/projectPaste.js — Reads a developer's launch message (pasted from WhatsApp) into the project's details (pure, no AI, free).
// What the message does not say stays empty: nothing is guessed. Place and features are read by domain/unitBox.js, developer
// and existing-project matching by services/projectPaste.js; this file reads the words and numbers.
// Output: { name_candidates, developer_candidates, area_acres, delivery_raw, delivery_year, status, price_from, down_pct_min,
//           years_max, discount_pct, bedrooms, property_types, offers, facts }
"use strict";

const { moneyPhrases } = require("./read/searchPrep");

const { normalizeDigits } = require("../lib/text");
const ProjectNotes = require("./projectNotes");

const NUM = String.raw`(\d[\d,٬]*(?:\.\d+)?)`;
const MAX_TEXT = 8000;

// A Latin phrase that is a company, not a project ("ARABISK DEVELOPMENT"), and words that are never a name.
const COMPANY = /\b(development|developments|developers|group|properties|real\s*estate|holding|investments?|urban|construction)\b/i;
const NOT_NAME = new Set(["NEW LAUNCH", "LAUNCH", "EGP", "LE", "PAYMENT PLAN", "TOTAL PRICE", "FROM", "DISCOUNT", "AFTER DISCOUNT", "NEW", "VIP", "SOLD OUT"]);

const TYPES = [
  ["office", /(مكتب|مكاتب|office|إداري|اداري|administrative)/i],
  ["clinic", /(عياده|عيادة|clinic|medical)/i],
  ["shop", /(محل|محلات|shop|retail|تجاري)/i],
  ["villa", /(فيلا|فيلات|villa)/i],
  ["townhouse", /(تاون\s*هاوس|town\s*house)/i],
  ["twin_villa", /(توين|twin)/i],
  ["chalet", /(شاليه|chalet)/i],
  ["duplex", /(دوبلكس|duplex)/i],
  ["penthouse", /(بنتهاوس|penthouse)/i],
  ["studio", /(ستوديو|studio)/i],
  ["apartment", /(شقه|شقة|شقق|apartment)/i]
];

// Other facts a launch message states: [key, label ar, label en, pattern with the value in group 1].
const FACTS = [
  ["consultant", "الاستشاري", "Consultant", /(?:استشاري(?:\s+هندس[يى])?|consultant)\s*[:\-–⬅➡️]*\s*([A-Za-z][A-Za-z0-9 &.\-]{1,40}|[؀-ۿ ]{3,40})/i],
  ["operator", "الإدارة والتشغيل", "Operator", /(?:ادار[هة]\s*(?:و\s*)?تشغيل(?:\s*بعقد\s*نهائي)?|operated\s*by|management)\s*[:\-–⬅➡️]*\s*([A-Za-z][A-Za-z0-9 &.\-]{1,40})/i],
  ["rental_mandate", "تفويض بالإيجار", "Rental mandate", /(تفويض\s*بالايجار[^\n]*|تفويض\s*بالإيجار[^\n]*|rental\s*(?:mandate|management)[^\n]*)/i],
  ["architect", "المعماري", "Architect", /(?:معماري|architect)\s*[:\-–⬅➡️]*\s*([A-Za-z][A-Za-z0-9 &.\-]{1,40})/i]
];

const clean = (s) => String(s || "").replace(/[‎‏‪-‮]/g, "").replace(/\s+/g, " ").trim();
const toNum = (s) => {
  const v = Number(String(s).replace(/[,٬\s]/g, ""));
  return Number.isFinite(v) ? v : null;
};

/** A price: "2,000,000", "5.875 مليون", "850 ألف"; null when it is not a plausible price. */
function priceOf(numText, word) {
  let v = toNum(numText);
  if (v == null) return null;
  if (/^(مليون|million|m)$/i.test(word || "")) v *= 1000000;
  else if (/^(ألف|الف|k)$/i.test(word || "")) v *= 1000;
  return v >= 100000 && v <= 5e9 ? Math.round(v) : null;
}

function nameCandidates(text, developer) {
  const out = [];
  const add = (s) => {
    const n = clean(s).replace(/^[\s:\-–"“”'()]+|[\s:\-–"“”'()!.،,]+$/g, "");
    if (n.length < 3 || n.length > 60 || /\d{4,}/.test(n) || /^[A-Z]{1,3}\d+$/.test(n)) return;
    if (NOT_NAME.has(n.toUpperCase()) || (developer && n.toLowerCase() === developer.toLowerCase())) return;
    const low = n.toLowerCase();
    if (!out.some((x) => x.toLowerCase().startsWith(low) || low.startsWith(x.toLowerCase()))) out.push(n);
  };
  // "PMC Mall 📍 (MU23)": the name sits before the pin.
  for (const m of text.matchAll(/^[^\n]*📍/gm)) add(m[0].replace(/📍.*$/, ""));
  // "كمبوند X", "compound X" (a plain "مشروع" is too common a word to name one in Arabic; before a Latin name it counts).
  for (const m of text.matchAll(/(?:كمبوند|كومبوند|compound|project|مشروع)[ \t]+([A-Za-z][A-Za-z0-9&'.\-]*(?:[ \t]+[A-Za-z][A-Za-z0-9&'.\-]*){0,3})/gi)) add(m[1]);
  for (const m of text.matchAll(/(?:كمبوند|كومبوند)[ \t]+([؀-ۿ]+(?:[ \t]+[؀-ۿ]+)?)/g)) add(m[1]);
  // A Latin phrase in capitals ("JAZEEL RESIDENCE", "THE NEW BALANCE"), the most often repeated first.
  const caps = new Map();
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9&']{2,}(?:[ \t]+[A-Z][A-Z0-9&']{1,}){0,3}\b/g)) {
    const phrase = clean(m[0]);
    if (COMPANY.test(phrase) || NOT_NAME.has(phrase)) continue;
    caps.set(phrase, (caps.get(phrase) || 0) + 1);
  }
  [...caps.entries()].sort((a, b) => b[1] - a[1]).forEach(([p]) => add(p));
  return out.slice(0, 4);
}

function developerCandidates(text) {
  const out = [];
  const add = (s) => {
    const n = clean(s).replace(/^[\s:\-–]+|[\s:\-–!.،,]+$/g, "");
    if (n.length >= 3 && n.length <= 60 && !out.some((x) => x.toLowerCase() === n.toLowerCase())) out.push(n);
  };
  for (const m of text.matchAll(/\b[A-Z][A-Za-z0-9&']{2,}(?:[ \t]+[A-Za-z][A-Za-z0-9&']{1,}){0,3}\b/g)) if (COMPANY.test(m[0]) && m[0] === m[0].toUpperCase()) add(m[0]);
  for (const m of text.matchAll(/(?:شركة|مطور|المطور|تطوير|developer)\s+(?:ال)?([A-Za-z][A-Za-z0-9&'.\-]*(?:\s+[A-Za-z][A-Za-z0-9&'.\-]*){0,2}|[؀-ۿ]+(?:\s+[؀-ۿ]+){0,2})/gi)) add(m[1]);
  return out.slice(0, 3);
}

/** One offer from "key ⬅️ value" lines (area, floor, price), for a message about a single unit. */
function singleOffer(text) {
  const area = (text.match(/(?:المساحه|المساحة|area)\s*[^\d\n]{0,8}(\d+(?:\.\d+)?)/i) || [])[1];
  const priceM = text.match(new RegExp(String.raw`(?:السعر|سعر|price)\s*[^\d\n]{0,8}${NUM}\s*(مليون|million|ألف|الف)?`, "i"));
  const price = priceM ? priceOf(priceM[1], priceM[2]) : null;
  if (!price) return null;
  const floor = (text.match(/الدور\s*[^\p{L}\d\n]{0,8}(\p{L}+)/u) || [])[1] || null;
  // A price alone ("prices start from …") is the project's price from, not a unit: a unit has a size or a floor.
  if (!area && !floor) return null;
  return { area: area ? Number(area) : null, floor, price };
}

/** @param {string} input the pasted message */
function read(input) {
  const text = normalizeDigits(String(input || "").slice(0, MAX_TEXT)).replace(/[‎‏‪-‮]/g, "");
  const flat = moneyPhrases(text).replace(/\s+/g, " ");
  const developers = developerCandidates(text);
  const out = {
    name_candidates: nameCandidates(text, developers[0]),
    developer_candidates: developers,
    area_acres: null,
    delivery_raw: null,
    delivery_year: null,
    status: null,
    price_from: null,
    down_pct_min: null,
    years_max: null,
    discount_pct: null,
    bedrooms: [],
    property_types: [],
    offers: [],
    facts: []
  };

  const acres = flat.match(/(\d+(?:\.\d+)?)\s*(?:feddan|fedan|faddan|فدان|فدّان)/i);
  if (acres) out.area_acres = Number(acres[1]);

  out.bedrooms = [...new Set([...flat.matchAll(/(\d)\s*(?:bedrooms?|br\b|غرف|غرفة|غرفه)/gi)].map((m) => Number(m[1])).filter((n) => n >= 1 && n <= 9))].sort((a, b) => a - b);

  for (const [type, re] of TYPES) if (re.test(flat)) out.property_types.push(type);
  if (out.bedrooms.length && !out.property_types.length) out.property_types.push("apartment");

  // Delivery: "استلام سنه واحدة فقط", "استلام فوري", "delivery 2028", "تسليم 2027".
  const deliv = flat.match(/(?:استلام|تسليم|delivery)[^.\n]{0,40}/i);
  if (deliv) {
    out.delivery_raw = clean(deliv[0]).slice(0, 80);
    const y = out.delivery_raw.match(/\b(20[2-4]\d)\b/);
    if (y) out.delivery_year = Number(y[1]);
  }
  if (/(new\s*launch|\blaunch|لونش|إطلاق|اطلاق)/i.test(flat)) out.status = "launching";

  // Offers: one per unit line when the message lists units (priced lines), else one from "key ⬅️ value" lines.
  const discountOf = (s) => {
    const m = s.match(/(?:خصم|discount)\s*(\d+(?:\.\d+)?)\s*%/i) || s.match(/(\d+(?:\.\d+)?)\s*%\s*(?:خصم|discount)/i);
    return m ? Number(m[1]) : null;
  };
  let offers = ProjectNotes.parseUnits(text).map((u) => ({ ...u, discount_pct: discountOf(u.raw) }));
  if (!offers.length) {
    const one = singleOffer(text);
    if (one) offers = [{ ...one, bedrooms: null, down: null, monthly: null, monthly_est: null, years: null, raw: clean(flat).slice(0, 200), discount_pct: null }];
  }
  const typeOf = (raw) => (TYPES.find(([, re]) => re.test(raw)) || [])[0] || (out.property_types.length === 1 ? out.property_types[0] : null);
  out.offers = offers.map((o) => ({ ...o, property_type: typeOf(o.raw) }));

  // Price from: "Total Price from 2,000,000", "يبدأ من 3 مليون"; else the lowest offer.
  const from = flat.match(new RegExp(String.raw`(?:price\s*from|starting\s*(?:from|at)|from\s*price|يبدأ\s*من|تبدأ\s*من|ابتداء\s*من|بداية\s*من|بدايه\s*من|سعر\s*يبدأ)\s*[^\d]{0,12}${NUM}\s*(مليون|million|ألف|الف)?`, "i"));
  const fromPrice = from ? priceOf(from[1], from[2]) : null;
  const offerPrices = out.offers.map((o) => o.price).filter(Boolean);
  out.price_from = [fromPrice, ...offerPrices].filter(Boolean).sort((a, b) => a - b)[0] || null;

  // Down payment and term: the lowest down payment and the longest term the message offers.
  const downs = [...flat.matchAll(/(?:مقدم(?:ات)?|down\s*payment|downpayment)[^\d%]{0,20}(\d+(?:\.\d+)?)\s*%/gi)].map((m) => Number(m[1])).filter((n) => n > 0 && n <= 100);
  if (downs.length) out.down_pct_min = Math.min(...downs);
  // A year count is a term unless it follows the delivery word ("استلام سنه واحدة" is not one).
  const withoutDelivery = flat.replace(/(?:استلام|تسليم|delivery)[^.\n]{0,40}/gi, " ");
  const years = [...withoutDelivery.matchAll(/(\d{1,2})\s*(?:سنين|سنوات|سنه|سنة|years?|yrs?)/gi)].map((m) => Number(m[1])).filter((n) => n >= 1 && n <= 20);
  const offerYears = out.offers.map((o) => o.years).filter(Boolean);
  const allYears = [...years, ...offerYears];
  if (allYears.length) out.years_max = Math.max(...allYears);
  const discounts = [discountOf(flat), ...out.offers.map((o) => o.discount_pct)].filter((n) => n != null && n > 0 && n <= 100);
  if (discounts.length) out.discount_pct = Math.max(...discounts);

  for (const [key, ar, en, re] of FACTS) {
    const m = text.match(re);
    const value = m ? clean(m[1]).replace(/[:\-–⬅➡️]+$/, "").slice(0, 300) : "";
    if (value) out.facts.push({ key, label_ar: ar, label_en: en, value });
  }
  // The consultant and operator are not the project.
  const stated = new Set(out.facts.map((f) => f.value.toLowerCase()));
  out.name_candidates = out.name_candidates.filter((n) => !stated.has(n.toLowerCase()));
  return out;
}

module.exports = { read };
