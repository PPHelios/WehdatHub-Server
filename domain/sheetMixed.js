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
  const bua = new RegExp(`(?:bua|built[\\s-]*up(?:\\s*area)?|built|مباني|بناء)\\s*[:=]?\\s*${NUM}`).exec(s) || new RegExp(`${NUM}\\s*${SQM}?\\s*(?:bua|built[\\s-]*up|built|بناء)`).exec(s);
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
  const bed = /(\d{1,2})\s*(?:master\s+)?(?:be\w{2,6}|beds?|br\b|غرف\w*)/.exec(s);
  if (bed) out.bedrooms = Number(bed[1]);
  else {
    const w = /(غرفتين|غرفتان)/.exec(s);
    if (w) out.bedrooms = WORD_NUM[w[1]];
  }
  const bath = /(\d{1,2})\s*(?:bath\w*|bth\w*|حمام\w*|دورات? مياه)/.exec(s);
  if (bath) out.bathrooms = Number(bath[1]);
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
  if (rule === "long") return (cands.find((c) => LONG.test(c.part) && !SHORT.test(c.part)) || cands.find((c) => MONTH.test(c.part)))?.v ?? null;
  return null;
}

/** A price stated in dollars alone ("2000$", "$3000", "1500 USD") → the amount; null for anything with other numbers. */
function dollars(raw) {
  const m = /^\s*(?:\$\s*)?(\d[\d,]*(?:\.\d+)?)\s*(k)?\s*(?:\$|usd|dollars?|دولار)?\s*$/i.exec(clean(raw));
  if (!m || !FOREIGN.test(clean(raw))) return null;
  const v = num(m[1]) * (m[2] ? 1000 : 1);
  return v > 0 ? v : null;
}

module.exports = { areas, rooms, priceText, priceIn, pickPrice, dollars, readText, FOREIGN };
