// domain/sheetMixed.js — Reads the facts that sit together in one spreadsheet cell: "2 Bedrooms (1 master) / 3 Bathrooms",
// "land 600 m / built up 244 m", "60k negotiable", "$3000" (pure). Nothing is guessed: a value is returned only when the
// text states it, and a price in another currency is reported, never converted.
"use strict";

const AR = "٠١٢٣٤٥٦٧٨٩";
const digits = (s) => String(s).replace(/[٠-٩]/g, (d) => String(AR.indexOf(d)));
const clean = (v) => digits(v).replace(/[\\|;،]+/g, " / ").replace(/\s+/g, " ").trim();

const NUM = "(\\d{2,5}(?:[.,]\\d+)?)";
const SQM = "(?:m2|m²|sqm|sq\\.?\\s*m|meters?|metres?|m\\b|م2|م\\b|متر)";
const num = (x) => Number(String(x).replace(/,/g, ""));

/** "160m", "land 600 m / built up 244 m", "500m land / 290m bua" → { area_value (built-up or plain), land_area }. */
function areas(raw) {
  const s = clean(raw).toLowerCase();
  const out = {};
  const bua = new RegExp(`(?:bua|bue|built[\\s-]*up(?:\\s*area)?|built|مباني|بناء)\\s*[:=]?\\s*${NUM}`).exec(s) || new RegExp(`${NUM}\\s*${SQM}?\\s*(?:bua|built[\\s-]*up|built|بناء)`).exec(s);
  const land = new RegExp(`(?:land(?:\\s*area)?|plot|ارض|أرض)\\s*[:=]?\\s*${NUM}`).exec(s) || new RegExp(`${NUM}\\s*${SQM}?\\s*(?:land|plot|ارض|أرض)`).exec(s);
  if (bua) out.area_value = num(bua[1]);
  if (land) out.land_area = num(land[1]);
  if (!bua && !land) {
    const plain = new RegExp(`${NUM}\\s*${SQM}`).exec(s);
    if (plain) out.area_value = num(plain[1]);
  }
  return out;
}

const WORD_NUM = { غرفة: 1, غرفه: 1, غرفتين: 2, غرفتان: 2 };

/** Bedrooms and bathrooms from "2 Bedrooms (1 master) / 3 Bathrooms", "3 غرف و 2 حمام", "3br 2bath". */
function rooms(raw) {
  const s = clean(raw).toLowerCase();
  const out = {};
  const BED = "(?:master\\s+)?(?:be\\w{2,6}|beds?|br\\b|bdr?s?\\b|غرف\\w*|اوض\\w*|أوض\\w*|نوم)";
  const BATH = "(?:bath\\w*|bth\\w*|ba\\b|wc\\b|toilets?|حمام\\w*|دورات? مياه|دورة مياه)";
  const bed = new RegExp(`(?:bedrooms?|beds?|br|غرف(?:ة|ه)?|اوض(?:ة|ه)?)\\s*[:=]\\s*(\\d{1,2})`).exec(s) || new RegExp(`(\\d{1,2})\\s*${BED}`).exec(s);
  if (bed) out.bedrooms = Number(bed[1]);
  else {
    const w = /(غرفتين|غرفتان|اوضتين|أوضتين)/.exec(s);
    if (w) out.bedrooms = 2;
  }
  const bath = new RegExp(`(?:bathrooms?|baths?|ba|حمام(?:ات)?)\\s*[:=]\\s*(\\d{1,2})`).exec(s) || new RegExp(`(\\d{1,2})\\s*${BATH}`).exec(s);
  if (bath) out.bathrooms = Number(bath[1]);
  else if (/(حمامين)/.test(s)) out.bathrooms = 2;
  if (out.bedrooms > 20) delete out.bedrooms;
  if (out.bathrooms > 20) delete out.bathrooms;
  return out;
}

const FOREIGN = /(\$|usd|us\s*dollars?|dollars?|دولار|€|eur\b|euros?|يورو|£|gbp\b)/i;
const UNIT = "(k|m|mn|million|millions|thousand|الف|ألف|مليون)";

const scale = (n, u) => {
  const x = (u || "").toLowerCase();
  return /^(m|mn|million|millions|مليون)$/.test(x) ? Math.round(n * 1e6) : /^(k|thousand|الف|ألف)$/.test(x) ? Math.round(n * 1e3) : n;
};

/**
 * A price cell with words around the amount: "65K", "60k negotiable", "25k/2month insurance", "130k negotiable".
 * → { price_value, rest } or { foreign: true } for a price in dollars or euros, or { ambiguous: true } for two amounts.
 */
function priceText(raw) {
  const s = clean(raw);
  if (!s) return null;
  if (FOREIGN.test(s)) return { foreign: true };
  const amounts = [...s.matchAll(new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)\\s*${UNIT}?(?![\\w])`, "gi"))].map((m) => ({ n: num(m[1]), u: m[2], at: m.index, len: m[0].length }));
  if (!amounts.length) return null;
  const first = amounts[0];
  const value = scale(first.n, first.u);
  // "25k/2month insurance": a bare small number after the amount is a duration, not a second price.
  const prices = amounts.filter((a) => scale(a.n, a.u) >= 1000);
  if (prices.length > 1) return { ambiguous: true };
  if (!(value >= 100)) return null;
  const head = s.slice(0, first.at).trim();
  if (head && !/^(price|السعر|سعر|rent|ايجار|الايجار)\s*[:=]?$/i.test(head)) return null; // the amount is not the cell's lead
  return { price_value: value, rest: s.slice(first.at + first.len).replace(/^[\s/\-–:,.]+/, "").trim() || null };
}

/** Price stated inside a longer text: "price 40k", "السعر 40 ألف". */
function priceIn(raw) {
  const m = new RegExp(`(?:price|السعر|سعر|rent|ايجار)\\s*[:=]?\\s*(\\d[\\d,]*(?:\\.\\d+)?)\\s*${UNIT}?`, "i").exec(clean(raw));
  if (!m) return null;
  const v = scale(num(m[1]), m[2]);
  return v >= 100 ? v : null;
}

/** Every fact a free text states: rooms, areas, a price. */
function readText(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === "") return {};
  const out = { ...rooms(raw), ...areas(raw) };
  const p = priceIn(raw);
  if (p) out.price_value = p;
  return out;
}

const DAILY = /(\bday\b|daily|يومي|يوم)/i;
const SHORT = /(short|قصير)/i;
const LONG = /(\blong|\byear|annual|سنوي|طويل)/i;
const MONTH = /(month|monthly|شهري)/i;

/** The first amount in a text ("long 90k", "6000k short", "105,000 long"); null when none. */
function amountOf(part) {
  for (const m of clean(part).matchAll(new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)\\s*${UNIT}?(?![\\w])`, "gi"))) {
    const v = scale(num(m[1]), m[2]);
    if (v >= 100) return v;
  }
  return null;
}

/**
 * Chooses one price from a cell that lists several ("long 90k / short 100k / day 6k"). A daily price is never chosen.
 * rule "long": the price marked long-term or yearly, else the monthly one; rule "first": the first non-daily price.
 */
function pickPrice(raw, rule) {
  const parts = clean(raw).split(/\s*(?:\/|;|\+|\s-\s|\band\b)\s*/i).map((x) => x.trim()).filter(Boolean);
  const cands = parts.map((part) => ({ part, v: amountOf(part) })).filter((c) => c.v && !DAILY.test(c.part));
  if (rule === "first") return cands[0]?.v ?? null;
  // The monthly price first, else the long-term one. The other prices stay in the description (see services/imports.js).
  if (rule === "long") return (cands.find((c) => MONTH.test(c.part)) || cands.find((c) => LONG.test(c.part) && !SHORT.test(c.part)))?.v ?? null;
  return null;
}

/** A price stated in dollars alone ("2000$", "$3000", "1500 USD") → the amount; null for anything with other numbers. */
function dollars(raw) {
  const m = /^\s*(?:\$\s*)?(\d[\d,]*(?:\.\d+)?)\s*(k)?\s*(?:\$|usd|dollars?|دولار)?\s*$/i.exec(clean(raw));
  if (!m || !FOREIGN.test(clean(raw))) return null;
  const v = num(m[1]) * (m[2] ? 1000 : 1);
  return v > 0 ? v : null;
}

/**
 * The price a price cell means, by the owner's rules: a cell with several prices takes the long-term or monthly one
 * (else the first, never a daily one); a dollar amount stays in dollars; a cell with dollars and an EGP price takes the EGP.
 * → { value, usd } where value is the raw cell when nothing is read (the caller then reports it).
 */
function cellPrice(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { value: raw, usd: false };
  const usd = dollars(text);
  if (usd !== null) return { value: usd, usd: true };
  if (!FOREIGN.test(text)) {
    if (priceText(text)?.ambiguous !== true) return { value: raw, usd: false };
    const v = pickPrice(text, "long") ?? pickPrice(text, "first");
    return { value: v ?? raw, usd: false };
  }
  const egp = pickPrice(text, "long");
  if (egp) return { value: egp, usd: false };
  const seg = clean(text).split(/\s*(?:\/|;|\+)\s*/).find((p) => FOREIGN.test(p));
  const d = seg ? dollars(seg) : null;
  return d !== null ? { value: d, usd: true } : { value: raw, usd: false };
}

/** A figure as written: "3,000,000", "1.200.000", "7.326,000", "1,338,355.2", "7,200,00" → the digits. */
function figure(raw) {
  const x = String(raw).trim().replace(/\.(?=\d{3}(?!\d))/g, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(x)) return null;
  return Number(x);
}

/** An amount with its unit: "6 M" is 6,000,000, "193,224 k" stays 193,224; a bare figure under 1,000 is held. */
function amountWithUnit(raw, unit) {
  const n = figure(raw);
  if (n === null || n <= 0) return null;
  const u = String(unit || "").toLowerCase();
  if (n < 1000 && u === "m") return n * 1e6;
  if (n < 1000 && u === "k") return n * 1e3;
  return n >= 1000 ? n : null;
}

/**
 * A resale price cell that states an installment plan: "total 3,000,000 / down payment 2,485,000 / installments 515,000
 * till Feb 2026". → { price_value, down_payment_value, remaining_amount } or null when the figures are not all read.
 * The whole text is kept by the caller (it goes into the description with the dates and months).
 */
function installmentOf(raw) {
  const s = clean(raw).toLowerCase();
  const num = "([\\d][\\d.,]*)\\s*(m|k)?(?![\\w])";
  const total = new RegExp(`total(?:\\s*price)?\\s*[:=]?\\s*${num}`).exec(s);
  const dp = new RegExp(`(?:down\\s*payment|downpayment|d\\.?\\s*p\\.?)\\s*[:=]?\\s*${num}`).exec(s);
  const inst = new RegExp(`(?:installments?|remain\\w*)\\s*[:=]?\\s*${num}`).exec(s) || new RegExp(`${num}\\s*installments?`).exec(s);
  if (!dp || !inst) return null;
  const down = amountWithUnit(dp[1], dp[2]);
  const remaining = amountWithUnit(inst[1], inst[2]);
  if (!down || !remaining) return null;
  const stated = total ? amountWithUnit(total[1], total[2]) : null;
  if (total && stated === null) return null; // a total that cannot be read is held, not worked out
  return { price_value: stated ?? down + remaining, down_payment_value: down, remaining_amount: remaining };
}

module.exports = { areas, rooms, priceText, priceIn, pickPrice, dollars, readText, FOREIGN, cellPrice, installmentOf };
