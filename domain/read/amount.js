// domain/read/amount.js — The one shared money reader (Parser consolidation, Phase 1).
// Reads amounts like "3.5 مليون", "٣ ونص مليون", "5 مليون الا ربع", "7 مليون و 200", "450 الف",
// "8.500.000", "5.5م", "1,5 مليون", "3 mn", "2m".
// It returns what the text says: { value, hadUnit, unitWord, sure, currency }. It never decides what the amount MEANS
// (ceiling, exact, minimum): the caller does. sure=false when the reading may be wrong (two bare numbers,
// an unknown word right after a bare number, a lone "م" that could be metres).
// Pure. No network, no DB.
"use strict";

const { norm, WORD_ALT, wordValue } = require("./numbers");

const L = "\\p{L}";
const N = "\\p{N}";
const MILLION = "(?:مليونين|ملايين|مليون|million|mln|mio|mn|melyon|milyon|melion|milion|meleon|m|م)";
const THOUSAND = "(?:الاف|الف|thousand|alf|elf|k)";
const FRACS = { نصف: 0.5, نص: 0.5, ربع: 0.25, تلت: 1 / 3, ثلث: 1 / 3 };
const FRAC_ALT = "(?:نصف|نص|ربع|تلت|ثلث)";

// Words that follow a number and show it is NOT money.
const NOT_MONEY = new Set(
  ("غرف غرفه غرفتين غرفتان اوض اوضه اوضتين حمام حمامات bed beds br bedroom bedrooms bath baths room rooms " +
    "متر sqm sq sqft قدم دور طابق ادوار floor سنه سنين سنوات سنتين year years شهر شهور يوم ايام فدان قيراط سهم " +
    "كيلو كم km م² m² م2 m2").split(" "),
);
// Words that normally follow a price and do not make it unsure.
const MONEY_TRAIL = new Set(
  ("جنيه جنيها جنيهات ج egp le pound pounds ريال دولار usd dollar dollars euro يورو eur $ كاش cash تقسيط مقدم قسط " +
    "شهريا فقط بس في ب ل لل من الي الى حتى او و علي على مع شامل لحد لغاية تقريبا اجمالي بالاجمالي سعر السعر والباقي " +
    "بحد اقصي max min").split(" "),
);

function detectCurrency(s) {
  if (/\$|\busd\b|دولار|dollar/.test(s)) return "USD";
  if (/€|\beur\b|يورو|euro/.test(s)) return "EUR";
  return "EGP";
}

// Digit token → number. Handles 8.500.000 / 1,500,000 (thousand marks), 1,5 / 5.5 (decimal), 450.000.
function numberFromDigits(tok, millionUnitFollows) {
  const dots = (tok.match(/\./g) || []).length;
  const commas = (tok.match(/,/g) || []).length;
  let t = tok;
  if (dots && commas) {
    const dec = Math.max(t.lastIndexOf("."), t.lastIndexOf(","));
    t = t.slice(0, dec).replace(/[.,]/g, "") + "." + t.slice(dec + 1);
  } else if (dots + commas >= 2) {
    t = t.replace(/[.,]/g, "");
  } else if (dots + commas === 1) {
    const after = t.split(/[.,]/)[1];
    if (after.length === 3 && !millionUnitFollows) t = t.replace(/[.,]/g, "");
    else t = t.replace(",", ".");
  }
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : null;
}

const TOKEN = new RegExp(
  `(?<![${L}${N}.,])(?:(?<d>\\d[\\d.,]*\\d|\\d)|(?<w>${WORD_ALT})(?![${L}${N}])|(?<f>${FRAC_ALT})(?=\\s*(?:مليون|الف|million|m(?![${L}${N}])|k(?![${L}${N}])))|(?<u>مليونين|ملايين|مليون|الفين|الاف|الف)(?![${L}${N}]))`,
  "giu",
);

const UNIT_RE = new RegExp(`^\\s*(${MILLION}|${THOUSAND})(?![${L}${N}²³])`, "iu");
const FRAC_BEFORE_RE = new RegExp(
  `^\\s*(?:(?:و\\s*)?(${FRAC_ALT})|(الا)\\s*(${FRAC_ALT}))\\s*(?=(?:مليون|ملايين|الف|million|mn|m(?![${L}${N}])|م(?![${L}${N}])|k(?![${L}${N}])))`,
  "iu",
);
const FRAC_AFTER_RE = new RegExp(`^\\s*(?:(?:و\\s*)?(${FRAC_ALT})|(الا)\\s*(${FRAC_ALT}))(?![${L}${N}])`, "iu");
const EXTRA_RE = new RegExp(`^\\s*و\\s*(\\d{1,3})(?:\\s*(${THOUSAND}))?(?![\\d.,])`, "iu");
const NEXT_WORD_RE = new RegExp(`^\\s{0,2}([${L}²³%٪$][${L}${N}²³.]*|[%٪$])`, "u");
const PRICE_CUE_RE = /(?:^|\s)(?:ب|بسعر|سعر|السعر|price|budget|ميزانيه|ميزانيتي|حتي|حتى|max|اقصي|الحد|حد)\s*$/;
// A number right after one of these words is a floor, an area or a count, not a price.
const COUNT_CUE_RE = /(?:^|\s)(?:دور|الدور|طابق|الطابق|floor|مساحه|المساحه|area|غرف|غرفه|rooms|bedrooms|عدد|bua|land)\s*$/;
const CODE_CUE_RE =/(?:كود|code|رقم|no|#|ref|id)\s*$/;

function multOf(unit) {
  return new RegExp(`^${MILLION}$`, "iu").test(unit) ? 1e6 : 1e3;
}

function scan(text) {
  const s = norm(text);
  const currency = detectCurrency(s);
  const out = [];
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(s))) {
    const g = m.groups;
    const start = m.index;
    let pos = start + m[0].length;
    const before = s.slice(0, start);
    let num = null;
    let frac = 0;
    let bareUnitWord = null; // a unit word standing alone, e.g. "مليونين"
    const isDigits = !!g.d;

    if (g.d) {
      const digitsOnly = g.d.replace(/[.,]/g, "");
      if (digitsOnly.length >= 10 && /^[01]/.test(g.d)) continue; // phone number
      if (CODE_CUE_RE.test(before)) continue; // unit code
      const ahead = s.slice(pos);
      const mil = new RegExp(`^\\s*(?:(?:و\\s*)?${FRAC_ALT}\\s*)?(?:مليون|ملايين|million|mn|mio)`, "iu").test(ahead);
      num = numberFromDigits(g.d, mil);
      if (num === null) continue;
      // "الدور 5", "مساحة 150", "غرف 3": a small number after these words is a floor, an area or a count.
      // (Skipped below, once we know no unit follows: "غرف 4 مليون" is a price.)
    } else if (g.w) {
      num = wordValue(g.w);
    } else if (g.f) {
      frac = FRACS[g.f];
      num = 0;
    } else if (g.u) {
      if (g.u === "ملايين" || g.u === "الاف") continue; // plural with no number
      bareUnitWord = g.u;
      num = g.u === "مليونين" || g.u === "الفين" ? 2 : 1;
    }

    let rest = s.slice(pos);
    let unit = null;
    let unitWord = null;
    let sure = true;
    let fracBefore = frac;

    if (bareUnitWord) {
      unit = bareUnitWord;
      unitWord = bareUnitWord;
    } else {
      const fb = FRAC_BEFORE_RE.exec(rest);
      if (fb) {
        const f = FRACS[fb[1] || fb[3]];
        fracBefore += fb[2] ? -f : f;
        pos += fb[0].length;
        rest = s.slice(pos);
      }
      const um = UNIT_RE.exec(rest);
      if (um) {
        unitWord = um[1];
        unit = unitWord;
        pos += um[0].length;
        rest = s.slice(pos);
      }
    }

    if (isDigits && !unit && num < 1000 && COUNT_CUE_RE.test(before)) {
      TOKEN.lastIndex = pos;
      continue;
    }

    // A single letter m / م is millions only when it is clearly money; otherwise it is metres.
    if (unit && /^(m|م)$/i.test(unit)) {
      const decimal = isDigits && num % 1 !== 0;
      const cue = PRICE_CUE_RE.test(before);
      if (!cue && !decimal && num >= 20) {
        TOKEN.lastIndex = pos;
        continue;
      }
      if (!cue && !decimal && num >= 10) sure = false;
    }

    // A number word with no unit is a count (rooms, floors), not money.
    if (!unit && !isDigits) {
      TOKEN.lastIndex = pos;
      continue;
    }

    let value;
    const hadUnit = !!unit;
    if (unit) {
      const mult = multOf(unit);
      let base = num + fracBefore;
      const fa = FRAC_AFTER_RE.exec(rest);
      if (fa) {
        const f = FRACS[fa[1] || fa[3]];
        base += fa[2] ? -f : f;
        pos += fa[0].length;
        rest = s.slice(pos);
      }
      value = base * mult;
      if (mult === 1e6) {
        const ex = EXTRA_RE.exec(rest);
        if (ex) {
          const tail = rest.slice(ex[0].length);
          const nextWord = NEXT_WORD_RE.exec(tail);
          const wordOk = !nextWord || MONEY_TRAIL.has(nextWord[1]);
          const lenOk = !!ex[2] || ex[1].length === 3;
          if (wordOk && lenOk && Number(ex[1]) > 0) {
            value += Number(ex[1]) * 1000;
            pos += ex[0].length;
          }
        }
      }
      value = Math.round(value);
    } else {
      value = Math.round(num + fracBefore);
      const nw = NEXT_WORD_RE.exec(rest);
      if (nw) {
        const w = nw[1];
        if (NOT_MONEY.has(w) || /^[%٪]$/.test(w)) {
          TOKEN.lastIndex = pos;
          continue;
        }
        if (!MONEY_TRAIL.has(w)) sure = false;
      }
    }

    out.push({ value, hadUnit, unitWord, sure, currency, index: start, end: pos, raw: s.slice(start, pos).trim() });
    TOKEN.lastIndex = pos;
  }

  // Two or more bare numbers: none of them is sure.
  const bare = out.filter((o) => !o.hadUnit);
  if (bare.length > 1) bare.forEach((o) => (o.sure = false));
  // A bare number sitting right after a unit amount ("7 مليون 200") is also unsure.
  out.forEach((o, i) => {
    if (!o.hadUnit && i > 0 && out[i - 1].hadUnit && o.index - out[i - 1].end <= 2) o.sure = false;
  });
  return out;
}

// Every money amount in the text, in order.
function readAmounts(text) {
  if (text === null || text === undefined || text === "") return [];
  return scan(text);
}

// The main amount: the first one with a unit, else the first bare one. null when there is none.
function readAmount(text) {
  const all = readAmounts(text);
  if (!all.length) return null;
  const pick = all.find((a) => a.hadUnit) || all[0];
  const { value, hadUnit, unitWord, sure, currency } = pick;
  return { value, hadUnit, unitWord, sure, currency };
}

// The text is ONE amount and nothing else (a cell like "٣ ونص مليون جنيه"): its value, else null. Used by cell readers.
function readWhole(text) {
  const all = readAmounts(text);
  if (all.length !== 1 || !all[0].sure || !all[0].hadUnit) return null;
  const a = all[0];
  const s = norm(text);
  const left = (s.slice(0, a.index) + " " + s.slice(a.end)).replace(/[\s.,:;()\-]+/g, " ").trim();
  const words = left ? left.split(" ") : [];
  return words.every((w) => MONEY_TRAIL.has(w) || /^(egp|le|usd|\$)$/.test(w)) ? a.value : null;
}

module.exports = { readAmount, readAmounts, readWhole };
