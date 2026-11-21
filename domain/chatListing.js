// domain/chatListing.js — A WhatsApp post (free Arabic, Franco or English text) → the same "cells" an Excel row holds
// (code, compound, property_type, listing_type, price_value, area_value, ...), so one planner reads both (pure).
// The parser only fills what it is sure of; anything it cannot read stays empty and is listed in `missing`, so the
// caller can show them in red for the person to complete (the WhatsApp import reads with rules only, no AI).
"use strict";

const { latin } = require("./chatParse");
const { normalizeSearch } = require("./searchText");
const SheetImport = require("./sheetImport");
const { readAmounts } = require("./read/amount");
const { readRooms } = require("./read/rooms");
const { readArea } = require("./read/area");
const { readFloor } = require("./read/floor");
const { norm, toAsciiDigits } = require("./read/numbers");
const Places = require("./mapPlaces");
const Features = require("./features");
const Sanity = require("./read/sanity");

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

// Arabic number words, folded (alef forms, ة->ه, ى->ي). shortcut: area only, up to the thousands; no millions, no fractions.
const WORD_NUM = {};
"واحد 1 اتنين 2 اثنين 2 تلاته 3 ثلاثه 3 اربعه 4 خمسه 5 سته 6 سبعه 7 تمانيه 8 ثمانيه 8 تسعه 9 عشره 10 احداشر 11 اتناشر 12 عشرين 20 تلاتين 30 ثلاثين 30 اربعين 40 خمسين 50 ستين 60 سبعين 70 تمانين 80 ثمانين 80 تسعين 90 ميه 100 مايه 100 مئه 100 مائه 100 ميت 100 ميتين 200 مئتين 200 مائتين 200 تلتميه 300 ثلاثميه 300 ربعميه 400 اربعميه 400 خمسميه 500 ستميه 600 سبعميه 700 تمنميه 800 تسعميه 900 الف 1000 الفين 2000"
  .split(" ").forEach((w, i, a) => { if (i % 2 === 0) WORD_NUM[w] = Number(a[i + 1]); });
const foldWord = (w) => w.replace(/[ً-ْ]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي");
const wordValue = (w) => { const f = foldWord(w); return WORD_NUM[f] ?? (f.startsWith("و") ? WORD_NUM[f.slice(1)] : undefined); };

/** "مساحة مية وخمسين متر" -> "مساحة 150 متر": a run of number words next to an area label or "متر" becomes digits. */
function areaWordsToDigits(text) {
  const parts = text.split(/(\s+)/); // words at even indexes, spaces at odd
  for (let i = 0; i < parts.length; i += 2) {
    if (wordValue(parts[i]) === undefined) continue;
    let j = i;
    while (j + 2 < parts.length && wordValue(parts[j + 2]) !== undefined) j += 2;
    if (/^(?:ال)?مساح[ةه]$/.test(parts[i - 2] || "") || /^(?:متر|م2|م²)$/.test(parts[j + 2] || "")) {
      let total = 0, cur = 0;
      for (let k = i; k <= j; k += 2) {
        const v = wordValue(parts[k]);
        if (v === 1000) { total += (cur || 1) * 1000; cur = 0; }
        else if (v === 100 && cur > 0 && cur < 10) cur *= 100;
        else cur += v;
      }
      parts.splice(i, j - i + 1, String(total + cur));
    }
    else i = j;
  }
  return parts.join("");
}

/** An area number that is not the land, garden or roof: the first "150 م" or "مساحة 150". */
function findArea(text) {
  // The built-up area is the unit's area (a villa lists land and built-up apart).
  const bua = new RegExp(`(?:build[\\s-]*up|built[\\s-]*up|bua|مباني|المباني)\\s*(?:area|مساحة)?\\s*[:\\-=]?\\s*(${NUM})`, "i").exec(text);
  if (bua) return bua[1];
  const re = new RegExp(`(${NUM})\\s*(?:م2|م²|متر|م(?![\\u0621-\\u064A])|m(?![a-z0-9²])|sqm|sq\\.?\\s*m|m2|m²)|(?:مساحة|مساحه|area|bua)\\s*[:\\-=]?\\s*(${NUM})`, "gi");
  const labelled = new RegExp("(?:مساحة|مساحه|المساحة|area)\\s*[:\\-=]?\\s*(" + NUM + ")", "i").exec(text);
  if (labelled && Number(String(labelled[1]).replace(/,/g, "")) >= 20 && !/(ارض|أرض|land|garden|جاردن|حديقة|روف|roof)\s*$/i.test(text.slice(Math.max(0, labelled.index - 8), labelled.index))) return labelled[1];
  for (const m of text.matchAll(re)) {
    const before = text.slice(Math.max(0, m.index - 14), m.index);
    if (new RegExp("(?:" + DIM_WORDS + ")\\s*[:\\-=]?\\s*$", "i").test(before)) continue;
    if (Number(String(m[1] || m[2]).replace(/,/g, "")) < 20) continue;
    if (!m[2] && /(ارض|أرض|land|garden|جاردن|حديقة|روف|roof|مسطح)/i.test(before)) continue;
    if (m[2] && /(ارض|أرض|land|garden|جاردن|حديقة|روف|roof)\s*$/i.test(text.slice(Math.max(0, m.index - 8), m.index))) continue;
    return m[1] || m[2];
  }
  return null;
}

const SIZE_WORDS = "land|build[\\s-]*up|built[\\s-]*up|bua|area|مساحة|مساحه|ارض|أرض|مباني|garden|جاردن|حديقة|روف|roof|terrace|تراس";
const DIM_WORDS = "واجهة|واجهه|شارع|ارتفاع|عرض|front(?:age)?|street|height|width|ceiling|depth";
const MONEY_SIGNAL = /\d[\d.,]*\s*(?:مليون|ملايين|million|mil\b|الف|ألف|k\b|\$|دولار|usd|egp|جنيه)|\$\s*\d|(?:السعر|سعر|price|المطلوب)\s*[:\-=]?\s*\d/i;

/** Where the text states a size or a dimension: [{ at, text }]. Each is later hidden from the price readers. */
function sizeSpans(t) {
  const spans = [];
  const add = (m) => spans.push({ at: m.index, text: m[0] });
  // A labelled size or dimension: "land area 420m", "garden 80m", "frontage 12m", "مساحة 150م".
  for (const m of t.matchAll(new RegExp("(?:" + SIZE_WORDS + "|" + DIM_WORDS + ")\\s*(?:area|مساحة)?\\s*[:\\-=]?\\s*\\d[\\d.,]*\\s*(?:m2|m²|م2|م²|m|م|sqm|متر)?(?![a-z\\d])", "gi"))) add(m);
  // A number with an unmistakable size unit.
  for (const m of t.matchAll(/(?<![\d.,])\d[\d.,]*\s*(?:m2|m²|م2|م²|متر|sqm|sq\.?\s*m)(?![a-z\d])/gi)) add(m);
  // A bare "160m" / "160م": a size when the post prices itself some other way ("40k", "$85,000", "السعر 5 مليون") and the number is a plausible size.
  const rest = spans.reduce((x, y) => x.slice(0, y.at) + " ".repeat(y.text.length) + x.slice(y.at + y.text.length), t);
  for (const m of rest.matchAll(/(?<![\d.,])(\d{2,4})\s*(?:m|م)(?![\p{L}\d²])/giu)) {
    const n = Number(m[1]);
    if (n < 20 || n > 3000) continue;
    if (/(?:السعر|سعر|بسعر|price|المطلوب)\s*[:\-=]?\s*$/i.test(rest.slice(Math.max(0, m.index - 12), m.index))) continue;
    const others = rest.slice(0, m.index) + " ".repeat(m[0].length) + rest.slice(m.index + m[0].length);
    if (MONEY_SIGNAL.test(others)) add(m);
  }
  return spans;
}

/**
 * @param {string} text the post
 * @param {{ index: Map, rows: object[] }|null} places approved places (for the compound)
 * @param {{ sender?: string, at?: string }} from who posted it and when (kept in the notes)
 * @returns {{ cells: object, read: string[], missing: string[] }}
 */
function parsePost(text, places = null, from = {}) {
  const original = String(text || "").slice(0, 4000);
  let t = areaWordsToDigits(toAsciiDigits(original).replace(/[‎‏‪-‮]/g, ""));
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
  const phone = take(/(?<!\d)(?:\+?20)?0?1[0125]\d{8}(?!\d)/);
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
  const PERIOD = "(?:شهري|شهريا|monthly|per\\s*month|سنوي|سنويا|yearly|annual|per\\s*year|يومي|daily|per\\s*day|short(?:\\s*term)?|long(?:\\s*term)?|قصير|طويل)";
  const periodRe = new RegExp(`(${PERIOD})\\s*[:\\-=]?\\s*(${MONEY}${CUR})|(${MONEY}${CUR})\\s*(?:ج\\S*|egp)?\\s*[/\\s]\\s*(${PERIOD})`, "gi");
  const periodPrices = [...t.matchAll(periodRe)].map((m) => ({ at: m.index, len: m[0].length, text: m[1] ? `${m[1]} ${m[2]}` : `${m[4]} ${m[3]}` }));
  if (periodPrices.length >= 2) {
    set("price_value", periodPrices.map((x) => x.text.replace(/\s+/g, " ").trim()).join(" / "));
    for (const x of periodPrices.slice().reverse()) t = t.slice(0, x.at) + " ".repeat(x.len) + t.slice(x.at + x.len);
  }

  // Sizes and dimensions are never prices. "land area 420m", "160m" beside another price, "frontage 12m", "120m $85,000": every span
  // that is a size is hidden from the price readers below and put back after, so a Latin m (million) after a size cannot become a price.
  const areaSpans = sizeSpans(t);
  for (const x of areaSpans) t = t.slice(0, x.at) + " ".repeat(x.text.length) + t.slice(x.at + x.text.length);

  // The shared amount reader sees the whole phrase ("22 مليون الا ربع", "5 مليون و 200", "3 مليون و 750 الف").
  const amounts = readAmounts(t).filter((a) => a.sure && a.hadUnit);
  // Price: after a price word, else a figure with million/thousand, else a long plain number.
  const price =
    take(new RegExp(`(?:السعر|سعر|بسعر|price|المطلوب|طالب|إجمالي|اجمالي|الإجمالي|الاجمالي|ايجار|إيجار|rent)\\s*[:\\-=]?\\s*(?:ب|ـ)?\\s*(${MONEY}${CUR})`, "i")) ||
    take(new RegExp(`(?<![\\d.,])(\\d{1,3}(?:,\\d{3}){2,}${CUR}|\\d{6,}${CUR})(?![\\d.,])`)) ||
    take(new RegExp(`(${NUM}\\s*(?:مليون|ملايين|million|mil|m(?![a-z0-9²])|الف|ألف)${CUR})`, "i")) ||
    take(/(\d[\d.,]*\s*k?\s*(?:\$|usd\b|دولار))/i) ||
    take(/(\$\s*\d[\d.,]*\s*k?)/i);
  if (price && !cells.price_value) {
    // The captured text can be the front of a longer amount: the reader's value wins when its phrase starts with it.
    const got = norm(price[1]).trim();
    const longer = got && amounts.find((a) => norm(a.raw).startsWith(got) && norm(a.raw).length > got.length);
    set("price_value", longer ? String(longer.value) : price[1]);
  } else if (!price && !cells.price_value && amounts.length === 1) {
    set("price_value", String(amounts[0].value)); // "مليون ونص", "ٍ٣ ونص مليون": phrasing the patterns above do not catch
  }

  for (const x of areaSpans) if (t.slice(x.at, x.at + x.text.length).trim() === "") t = t.slice(0, x.at) + x.text + t.slice(x.at + x.text.length);
  const area = findArea(t) || (() => {
    const r = readArea(t);
    return r.sure ? (r.built ?? r.plain) : null;
  })();
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

  // Bedrooms and bathrooms the patterns above missed ("تلات اوض", "غرفة وصالة", "bedrooms: 3"), when the reader is sure.
  const rr = readRooms(t);
  if (rr.sure && rr.bedroomsMax === null) {
    if (!cells.bedrooms && rr.bedrooms) set("bedrooms", rr.bedrooms);
    if (!cells.bathrooms && rr.bathrooms) set("bathrooms", rr.bathrooms);
  }

  const floor = /(?:الدور|دور|floor)\s*[:\-]?\s*(ارضي|أرضي|الارضي|ground|\d+|[ء-ي]+)/i.exec(t);
  if (floor) {
    const w = floor[1];
    set("floor", /^\d+$/.test(w) || /(ارضي|أرضي|ground)/i.test(w) ? w : ORDINAL[w] || null);
  }

  // The shared floor reader wins when it is sure ("3 غرف تاني دور" is the second floor, not the third).
  const fl = readFloor(original);
  if (fl.sure && fl.floor !== null) set("floor", fl.ground ? "ارضي" : String(fl.floor));
  else if (!fl.sure) delete cells.floor;

  const delivery = /(?:استلام|تسليم|delivery)\s*[:\-]?\s*([^\n،,.;]{2,30}?)(?=\s+(?:تشطيب|finishing|السعر|سعر|مساحة)|\s*[\n،,.;]|\s*$)/i.exec(t);
  if (delivery) set("delivery", delivery[1]);

  // Sale or rent; both words in one post is not a decision the parser makes.
  const rent = /(للايجار|للإيجار|ايجار|إيجار|\brent\b|for rent)/i.test(full);
  const sale = /(للبيع|(?<![\u0621-\u064A])بيع(?![\u0621-\u064A])|for sale|\bsale\b|resale|ريسيل)/i.test(full);
  if (rent && !sale) set("listing_type", "rent");
  else if (sale && !rent) set("listing_type", "sale");
  // A price given per period ("130$ short / 2700$ long", "90k شهري") is a rent; a sale post never prices that way. A monthly
  // figure beside an installment or down payment is a payment plan, not a rent, so those words rule it out.
  const RENT_PERIOD = /(?:monthly|per\s*month|شهري|شهريا|daily|per\s*day|يومي|short\s*(?:term)?|long\s*(?:term)?|per\s*year|yearly|annual|سنوي|سنويا)/i;
  // "135k year": a yearly figure in thousands is a rent ("per year" is already a period word; "8 years" is an installment term, not this).
  if (!cells.listing_type && !rent && !sale && /\d\s*(?:k|الف|ألف)\s*\/?\s*(?:year|yr|سنة|سنويا)\b(?!s)/i.test(full) && !/(قسط|اقساط|أقساط|installment|مقدم|down\s*payment)/i.test(full)) set("listing_type", "rent");
  if (!cells.listing_type && !rent && !sale && periodPrices.some((x) => RENT_PERIOD.test(x.text)) && !/(قسط|اقساط|أقساط|installment|مقدم|down\s*payment)/i.test(full)) set("listing_type", "rent");

  // Furnishing, in the app's own four values (the add/edit form's dropdown).
  const furn = SheetImport.furnishing(full);
  if (furn) set("furnishing", furn);

  // Property type: the first word the app's own type list knows.
  // "land area 420m" is the plot size, not the unit type.
  const forType = normalizeSearch(full).replace(/\b(?:land|ارض|الارض)\s*(?:area|مساحه)\s*[:\-=]?\s*\d+/g, " ");
  const typeWords = forType.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (let i = 0; i < typeWords.length; i++) {
    const token = typeWords[i];
    if (token.length < 3) continue;
    // "town house", "twin house": two words that are one type.
    const key = (typeWords[i + 1] && SheetImport.typeIn(token + typeWords[i + 1])) || SheetImport.typeIn(token);
    if (key) {
      set("property_type", key);
      break;
    }
  }

  const compound = findCompound(original, places);
  if (compound) set("compound", compound);

  // Features and orientation written inline ("3 غرف بحري"): one word, or two together, that the app's own feature list knows.
  const featureWords = [];
  const toks = original.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    for (const w of [toks[i], toks[i + 1] ? `${toks[i]} ${toks[i + 1]}` : null]) {
      if (w && w.length >= 3 && Features.classifyFeatures([w]).keys.length) { featureWords.push(w); break; }
    }
  }
  if (featureWords.length) set("features", [...new Set(featureWords)].join("، "));

  // The text goes in as the description: the shared row reader finds finishing and features in it, like for Excel.
  set("description", original.slice(0, 600));
  set("notes", ["WhatsApp", from.sender, from.at].filter(Boolean).join(" · "));

  // The last check: a value that cannot be a real unit's price, size or room count is dropped (empty beats wrong) and the reason kept.
  const suspect = Sanity.suspects(cells);
  for (const x of suspect) delete cells[x.cell];
  const read = Object.keys(cells).filter((k) => k !== "description" && k !== "notes");
  const missing = REQUIRED_CELLS.filter((k) => !(k in cells));
  return { cells, read, missing, suspect };
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
