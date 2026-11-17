// domain/read/searchPrep.js — Rewrites a search text into the forms the search parser already understands, using the
// shared readers (Parser consolidation, Phase 2). The parser itself is not touched for these: a text with none of these
// phrases comes back byte for byte the same, so no working search changes.
//   Franco ("3 ghorf fel tagamo3")        → Arabic words
//   "٣ ونص مليون", "5 مليون الا ربع"        → "3.5 مليون", "4.75 مليون"        (amount reader, sure readings only)
//   "تاني دور", "ارضي" (bare)              → "دور تاني", "دور ارضي"
//   "غرفة وصالة"                          → "1 غرف"
//   "سيمي فينشد", "كور اند شيل", "فول فينش" → words the finishing rules know
//   "مساحة 150"                           → "150 متر";  "450 sqm land, 380 BUA" → "380 متر" (built-up; land is ranking only)
// Pure. No network, no DB.
"use strict";

const { norm } = require("./numbers");
const { readAmounts } = require("./amount");
const { francoToArabic } = require("./franco");

const FRACTION_OR_EXTRA = /(?:^|\s)(?:و ?)?(?:نص|نصف|ربع|تلت|ثلث)(?!\p{L})|الا (?:نص|ربع|تلت)|(?:مليون|م|m) و ?\d/u;

function money(s) {
  let out = s;
  const all = readAmounts(s).filter((a) => a.sure && a.hadUnit && FRACTION_OR_EXTRA.test(` ${a.raw} `.replace(/ /g, " ")));
  for (const a of all.reverse()) {
    const m = a.value >= 1e6 ? `${+(a.value / 1e6).toFixed(3)} مليون` : `${+(a.value / 1e3).toFixed(3)} الف`;
    out = out.slice(0, a.index) + m + out.slice(a.end);
  }
  return out;
}

const SWAPS = [
  // finishing and furnishing words the parser knows
  [/(?<![\p{L}\p{N}])(?:سيمي|semi) ?(?:فينشد|فينيش|فينش|finished|finish|تشطيب)(?![\p{L}\p{N}])/giu, "نص تشطيب"],
  [/(?<![\p{L}\p{N}])(?:كور|core) ?(?:اند|و|&|and|n)? ?(?:شيل|شل|shell)(?![\p{L}\p{N}])/giu, "على الطوب"],
  [/(?<![\p{L}\p{N}])(?:فول|full) ?(?:فينشد|فينيش|فينش|finished|finish)(?![\p{L}\p{N}])/giu, "تشطيب كامل"],
  [/(?<![\p{L}\p{N}])(?:سيمي|semi) ?(?:فرنشد|فيرنشد|فرنيشد|furnished|furnish)(?![\p{L}\p{N}])/giu, "نص فرش"],
  [/(?<![\p{L}\p{N}])(?:فرنشد|فيرنشد|فرنيشد)(?![\p{L}\p{N}])/giu, "مفروشه"],
  // one bedroom and a reception
  [/(?<![\p{L}\p{N}])غرف[هة] ?و ?صال[هة](?![\p{L}\p{N}])/gu, "1 غرف"],
  // ordinal before the floor word
  [/(?<![\p{L}\p{N}])(?:ال)?(اول|تاني|ثاني|تالت|ثالث|رابع|خامس|سادس|سابع|تامن|ثامن|تاسع|عاشر) ?(?:دور|طابق)(?![\p{L}\p{N}])/gu, "دور $1"],
  // A size with a Latin m ("land 600m", "garden 60m", "600m land") is metres, never millions: the money rules must not see it.
  [/(?<![\p{L}\p{N}])(land|plot|garden|roof|terrace|bua|built ?up|build ?up) ?[:=]? ?(\d{2,5}) ?m(?![\p{L}\p{N}²])/giu, "$1 $2 متر"],
  [/(?<![\p{L}\p{N}.,])(\d{2,5}) ?m (land|plot|garden|roof|terrace|bua|built ?up|build ?up)(?![\p{L}\p{N}])/giu, "$1 متر $2"],
  // "مساحة 150" → "150 متر"
  [/(?<![\p{L}\p{N}])(?:مساح[هة]|area) ?[:=]? ?(\d{2,5})(?! ?(?:متر|م|sqm|m2|م2|m²))(?![\p{L}\p{N}])/giu, "$1 متر"],
];

function rewrite(s) {
  let out = s;
  for (const [re, to] of SWAPS) out = out.replace(re, to);
  // A bare "ارضي" (ground floor) with no "دور" before it: "شقة ارضي".
  out = out.replace(/(?<![\p{L}\p{N}])(?<!دور )(?<!الدور )(?<!طابق )(?<!الطابق )(?:ال)?(ارضي|ارضى|أرضي|أرضى)(?![\p{L}\p{N}])/gu, "دور ارضي");
  // Land and built-up together: keep the built-up area only ("450 sqm land, 380 BUA" → "380 متر").
  const LAND = /(\d{2,5}) ?(?:sqm|m2|m²|م2|متر)? ?(?:land|plot|ارض)(?![\p{L}\p{N}])[ ,،]*/giu;
  const BUILT = /(\d{2,5}) ?(?:sqm|m2|m²|م2|متر)? ?(?:bua|built ?up|مباني|بناء)(?![\p{L}\p{N}])/giu;
  if (LAND.test(out) && /(?:bua|built ?up|مباني|بناء)/iu.test(out)) {
    LAND.lastIndex = 0;
    out = out.replace(LAND, " ").replace(BUILT, "$1 متر");
  }
  return out;
}

/** The text the parser should read. Unchanged text comes back as it was. */
function prepareSearchText(text) {
  const original = String(text ?? "");
  if (!original.trim()) return original;
  let out = original;
  const fr = francoToArabic(out);
  if (fr.changed) out = fr.text;
  const folded = norm(out);
  const spaced = money(folded);
  const moved = rewrite(spaced);
  if (moved !== folded) return moved.replace(/\s+/g, " ").trim();
  return fr.changed ? out : original;
}

/**
 * Colloquial amounts written out in the text's own letters: "٣ ونص مليون" → "3.5 مليون", "5 مليون الا ربع" → "4.75 مليون".
 * Only sure readings are rewritten; the rest of the text is untouched. When folding would shift positions (diacritics,
 * tatweel) the text comes back as it was. Used by readers that must keep the original letters (pasted launch messages).
 */
function moneyPhrases(text) {
  const t = String(text ?? "");
  if (norm(t).length !== t.length) return t;
  return money(norm(t)) === norm(t) ? t : applySpans(t);
}

function applySpans(t) {
  let out = t;
  const all = readAmounts(t).filter((a) => a.sure && a.hadUnit && FRACTION_OR_EXTRA.test(` ${a.raw} `));
  for (const a of all.reverse()) {
    const m = a.value >= 1e6 ? `${+(a.value / 1e6).toFixed(3)} مليون` : `${+(a.value / 1e3).toFixed(3)} الف`;
    out = out.slice(0, a.index) + m + out.slice(a.end);
  }
  return out;
}

module.exports = { prepareSearchText, moneyPhrases };
