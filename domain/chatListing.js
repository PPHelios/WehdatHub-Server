// domain/chatListing.js — A WhatsApp post (free Arabic, Franco or English text) → the same "cells" an Excel row holds
// (code, compound, property_type, listing_type, price_value, area_value, ...), so one planner reads both (pure).
// The parser only fills what it is sure of; anything it cannot read stays empty and is listed in `missing`, so the
// caller can show them in red for the person to complete (the WhatsApp import reads with rules only, no AI).
"use strict";

const { latin } = require("./chatParse");
const { normalizeSearch } = require("./searchText");
const SheetImport = require("./sheetImport");
const Places = require("./mapPlaces");

const NUM = "\\d[\\d.,]*";
const UNIT = "(?:مليون|ملايين|million|mil|m(?![a-z0-9²])|الف|ألف|k(?![a-z]))";
const CUR = "(?:\\s*(?:\\$|usd\\b|us\\s*dollars?|dollars?|دولار))?";
const MONEY = `${NUM}\\s*${UNIT}?(?:\\s*(?:و|and)\\s*(?:نص|نصف|ربع|${NUM}\\s*${UNIT}))?`;
const ORDINAL = { الاول: 1, الأول: 1, اول: 1, التاني: 2, الثاني: 2, تاني: 2, التالت: 3, الثالث: 3, تالت: 3, الرابع: 4, رابع: 4, الخامس: 5, خامس: 5, السادس: 6, السابع: 7, الثامن: 8, التاسع: 9, العاشر: 10 };
const COUNT_WORDS = { واحد: 1, واحده: 1, اتنين: 2, اثنين: 2, تلات: 3, ثلاث: 3, تلاته: 3, ثلاثه: 3, اربع: 4, أربع: 4, اربعه: 4, خمس: 5, خمسه: 5, ست: 6 };
const REQUIRED_CELLS = ["compound", "property_type", "listing_type", "price_value", "area_value"];

/** Blank the matched span so later patterns do not read it again. */
const blank = (text, m) => text.slice(0, m.index) + " ".repeat(m[0].length) + text.slice(m.index + m[0].length);

function mask(text) {
  return String(text || "").replace(/[+٠-٩\d][٠-٩\d\s().-]{6,}[٠-٩\d]/g, "…").replace(/\s+/g, " ").trim().slice(0, 500);
}

/** The compound a text names: the longest run of 1 to 4 words that is an approved place name. */
function findCompound(text, places) {
  if (!places?.index) return null;
  const words = latin(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (let n = Math.min(4, words.length); n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const phrase = words.slice(i, i + n).join(" ");
      if (n === 1 && phrase.length < 4) continue;
      const id = places.index.get(Places.placeKey(phrase));
      if (id) {
        const row = places.rows.find((r) => r.id === id);
        if (row) return row.name_ar || row.name_en;
      }
    }
  }
  return null;
}

/** An area number that is not the land, garden or roof: the first "150 م" or "مساحة 150". */
function findArea(text) {
  // The built-up area is the unit's area (a villa lists land and built-up apart).
  const bua = new RegExp(`(?:build[\\s-]*up|built[\\s-]*up|bua|مباني|المباني)\\s*(?:area|مساحة)?\\s*[:\\-=]?\\s*(${NUM})`, "i").exec(text);
  if (bua) return bua[1];
  const re = new RegExp(`(${NUM})\\s*(?:م2|م²|متر|م(?![\\u0621-\\u064A])|m(?![a-z0-9²])|sqm|sq\\.?\\s*m|m2|m²)|(?:مساحة|مساحه|area|bua)\\s*[:\\-=]?\\s*(${NUM})`, "gi");
  for (const m of text.matchAll(re)) {
    const before = text.slice(Math.max(0, m.index - 14), m.index);
    if (!m[2] && /(ارض|أرض|land|garden|جاردن|حديقة|روف|roof|مسطح)/i.test(before)) continue;
    if (m[2] && /(ارض|أرض|land|garden|جاردن|حديقة|روف|roof)\s*$/i.test(text.slice(Math.max(0, m.index - 8), m.index))) continue;
    return m[1] || m[2];
  }
  return null;
}

/**
 * @param {string} text the post
 * @param {{ index: Map, rows: object[] }|null} places approved places (for the compound)
 * @param {{ sender?: string, at?: string }} from who posted it and when (kept in the notes)
 * @returns {{ cells: object, read: string[], missing: string[] }}
 */
function parsePost(text, places = null, from = {}) {
  const original = String(text || "").slice(0, 4000);
  let t = latin(original).replace(/[‎‏‪-‮]/g, "");
  const full = t;
  const cells = {};
  const set = (k, v) => {
    if (v !== null && v !== undefined && String(v).trim() !== "") cells[k] = String(v).trim();
  };
  const take = (re) => {
    const m = re.exec(t);
    if (m) t = blank(t, m);
    return m;
  };

  // The poster's own contact (a group post carries one); every unit needs an owner contact.
  const phone = take(/(?:\+?20)?0?1[0125]\d{8}/);
  if (phone) set("owner_phone", phone[0]);

  // A code the poster wrote: "كود HP-12", "code: N4-105", "#VIL-08".
  const code = take(/(?:كود(?:\s*(?:الوحدة|الداخلي))?|code)\s*[:#\-]?\s*([A-Za-z0-9][A-Za-z0-9_\-/.]{1,29})/i) || take(/[#`]([A-Za-z0-9][A-Za-z0-9_\-/.]{1,29})`?/);
  if (code) set("code", code[1].replace(/[./]+$/, "").toUpperCase());

  const down = take(new RegExp(`(?:مقدم|المقدم|دفعة|الدفعة|دفعه|الدفعه|down\\s*payment|dp)\\s*[:\\-=]?\\s*(${MONEY})`, "i"));
  if (down) set("down_payment_value", down[1]);
  const left = take(new RegExp(`(?:المتبقي|متبقي|باقي|الباقي|remaining)\\s*[:\\-=]?\\s*(${MONEY})`, "i"));
  if (left) set("remaining_amount", left[1]);
  const inst = take(new RegExp(`(?:القسط|قسط|installment)\\s*[:\\-=]?\\s*(${MONEY})`, "i"));
  if (inst) set("installment_value", inst[1]);

  // Several prices for different periods ("monthly 90k / yearly 1m", "90k شهري"): kept together in the price cell, like an
  // Excel cell with several prices, so the same rule picks one (monthly first, then long-term; a daily price is never used).
  const PERIOD = "(?:شهري|شهريا|monthly|per\\s*month|سنوي|سنويا|yearly|annual|per\\s*year|يومي|daily|per\\s*day|short\\s*term|long\\s*term|قصير|طويل)";
  const periodRe = new RegExp(`(${PERIOD})\\s*[:\\-=]?\\s*(${MONEY}${CUR})|(${MONEY}${CUR})\\s*(?:ج\\S*|egp)?\\s*[/\\s]\\s*(${PERIOD})`, "gi");
  const periodPrices = [...t.matchAll(periodRe)].map((m) => ({ at: m.index, len: m[0].length, text: m[1] ? `${m[1]} ${m[2]}` : `${m[4]} ${m[3]}` }));
  if (periodPrices.length >= 2) {
    set("price_value", periodPrices.map((x) => x.text.replace(/\s+/g, " ").trim()).join(" / "));
    for (const x of periodPrices.slice().reverse()) t = t.slice(0, x.at) + " ".repeat(x.len) + t.slice(x.at + x.len);
  }

  // Price: after a price word, else a figure with million/thousand, else a long plain number.
  const price =
    take(new RegExp(`(?:السعر|سعر|بسعر|price|المطلوب|طالب|إجمالي|اجمالي|الإجمالي|الاجمالي|ايجار|إيجار|rent)\\s*[:\\-=]?\\s*(?:ب|ـ)?\\s*(${MONEY}${CUR})`, "i")) ||
    take(new RegExp(`(?<![\\d.,])(\\d{1,3}(?:,\\d{3}){2,}${CUR}|\\d{6,}${CUR})(?![\\d.,])`)) ||
    take(new RegExp(`(${NUM}\\s*(?:مليون|ملايين|million|mil|m(?![a-z0-9²])|الف|ألف)${CUR})`, "i"));
  if (price && !cells.price_value) set("price_value", price[1]);

  const area = findArea(t);
  if (area) set("area_value", area);
  const land = new RegExp(`(?:land|ارض|أرض|الارض|الأرض)\\s*(?:area|مساحة)?\\s*[:\\-=]?\\s*(${NUM})`, "i").exec(t);
  if (land && land[1] !== area) set("land_area", land[1]);

  // Bedrooms and bathrooms: "3 غرف", "غرفتين", "3 bedrooms"; "2 حمام", "حمامين".
  const beds = /(\d+)\s*(?:غرف|غرفه|غرفة|نوم|bed(?:room)?s?|br\b)/i.exec(t) || /(?:غرف|غرفه|غرفة)\s*(?:نوم)?\s*[:\-]?\s*(\d)/i.exec(t);
  if (beds) set("bedrooms", beds[1]);
  else if (/غرفتين|غرفتان/.test(t)) set("bedrooms", 2);
  else {
    const w = /(واحد|واحده|اتنين|اثنين|تلات|ثلاث|تلاته|ثلاثه|اربع|أربع|اربعه|خمس|خمسه|ست)\s*غرف/.exec(normalizeSearch(t) ? t : "");
    if (w) set("bedrooms", COUNT_WORDS[w[1]]);
  }
  const baths = /(\d+)\s*(?:حمام|حمامات|bath(?:room)?s?|wc)/i.exec(t) || /(?:حمام|حمامات)\s*[:\-]?\s*(\d)/i.exec(t);
  if (baths) set("bathrooms", baths[1]);
  else if (/حمامين|حمامان/.test(t)) set("bathrooms", 2);

  const floor = /(?:الدور|دور|floor)\s*[:\-]?\s*(ارضي|أرضي|الارضي|ground|\d+|[ء-ي]+)/i.exec(t);
  if (floor) {
    const w = floor[1];
    set("floor", /^\d+$/.test(w) || /(ارضي|أرضي|ground)/i.test(w) ? w : ORDINAL[w] || null);
  }

  const delivery = /(?:استلام|تسليم|delivery)\s*[:\-]?\s*([^\n،,.;]{2,30}?)(?=\s+(?:تشطيب|finishing|السعر|سعر|مساحة)|\s*[\n،,.;]|\s*$)/i.exec(t);
  if (delivery) set("delivery", delivery[1]);

  // Sale or rent; both words in one post is not a decision the parser makes.
  const rent = /(للايجار|للإيجار|ايجار|إيجار|\brent\b|for rent)/i.test(full);
  const sale = /(للبيع|(?<![\u0621-\u064A])بيع(?![\u0621-\u064A])|for sale|\bsale\b|resale|ريسيل)/i.test(full);
  if (rent && !sale) set("listing_type", "rent");
  else if (sale && !rent) set("listing_type", "sale");

  // Furnishing, in the app's own four values (the add/edit form's dropdown).
  const furn = SheetImport.furnishing(full);
  if (furn) set("furnishing", furn);

  // Property type: the first word the app's own type list knows.
  for (const token of normalizeSearch(full).split(/[^\p{L}\p{N}]+/u)) {
    if (token.length < 3) continue;
    const key = SheetImport.typeIn(token);
    if (key) {
      set("property_type", key);
      break;
    }
  }

  const compound = findCompound(original, places);
  if (compound) set("compound", compound);

  // The text goes in as the description: the shared row reader finds finishing and features in it, like for Excel.
  set("description", original.slice(0, 600));
  set("notes", ["WhatsApp", from.sender, from.at].filter(Boolean).join(" · "));

  const read = Object.keys(cells).filter((k) => k !== "description" && k !== "notes");
  const missing = REQUIRED_CELLS.filter((k) => !(k in cells));
  return { cells, read, missing };
}

/** AI-read fields (lib/listingExtract output) → cells, only for the cells the parser left empty. */
function fillFromAi(cells, fields = {}) {
  const out = { ...cells };
  const filled = [];
  const put = (k, v) => {
    if (out[k] === undefined && v !== null && v !== undefined && String(v).trim() !== "") {
      out[k] = String(v).replace(/_/g, " ").trim();
      filled.push(k);
    }
  };
  for (const k of ["compound", "property_type", "listing_type", "price_value", "area_value", "bedrooms", "bathrooms", "down_payment_value", "remaining_amount", "installment_value"]) put(k, fields[k]);
  put("finishing", fields.finishing);
  put("floor", fields.details?.floor);
  return { cells: out, filled };
}

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
/** A cell or an AI value as a number: "8.6 مليون" / "8,600,000" / 8600000 all read 8600000; null when it holds no number. */
function numOf(v) {
  const t = String(v ?? "").replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d))).replace(/(\d),(?=\d{3}\b)/g, "$1").toLowerCase();
  const m = t.match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  let n = Number(m[0]);
  if (/مليون|million|\bm\b/.test(t)) n *= 1e6;
  else if (/الف|ألف|\bk\b|thousand/.test(t)) n *= 1e3;
  return n;
}
const fold = (v) => String(v ?? "").toLowerCase().replace(/_/g, " ").replace(/[\s\-ـ]+/g, " ").trim();

/**
 * Parser and AI read the same post: for each cell both gave, did they agree? Only cell names go to the log (never the values).
 * Numbers (price, area, rooms) are compared as numbers, words folded. Used to see where the parser can replace AI.
 */
function compareWithAi(cells = {}, fields = {}) {
  const ai = { ...fields, floor: fields.details?.floor };
  const agree = [];
  const differ = [];
  for (const k of ["compound", "property_type", "listing_type", "price_value", "area_value", "bedrooms", "bathrooms", "down_payment_value", "remaining_amount", "installment_value", "finishing", "floor"]) {
    const a = ai[k];
    if (cells[k] === undefined || a === undefined || a === null || String(a).trim() === "") continue;
    const numeric = ["price_value", "area_value", "bedrooms", "bathrooms", "down_payment_value", "remaining_amount", "installment_value"].includes(k);
    const same = numeric ? numOf(cells[k]) !== null && numOf(cells[k]) === numOf(a) : fold(cells[k]) === fold(a) || fold(cells[k]).includes(fold(a)) || fold(a).includes(fold(cells[k]));
    (same ? agree : differ).push(k);
  }
  return { agree, differ };
}

module.exports = { parsePost, fillFromAi, compareWithAi, numOf, findCompound, findArea, mask, REQUIRED_CELLS };
