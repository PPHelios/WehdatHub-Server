// domain/read/furnishing.js — Free text → one fixed furnishing status (Parser consolidation, Phase 1).
// furnished, semi_furnished, unfurnished, kitchen_and_ac, ac_only, kitchen_only.
// Negation is read first: "مش مفروشة" is unfurnished, not furnished. Conflicting words give { value: null, sure: false }.
// Pure. No network, no DB.
"use strict";

const { norm } = require("./numbers");

const FURN = "(?:مفروش\w*|فرش|فرنش\w*|فيرنش\w*|furnish\w*|furniture|اثاث)";
const NEG = "(?:مش|غير|بدون|من غير|مفيش|ما فيش|not|non|without|no|un)";
const KITCHEN = /مطبخ|kitchen/;
const AC = /تكييف|تكيف|مكيف|تكيفات|\bacs?\b|a c\b|air condition/;

const NEGATED = new RegExp(`(?:^| )${NEG} ?${FURN}`);
const UNFURN_WORDS = /(?:^| )(?:unfurnished|فاضي\p{L}*|فضي\p{L}*|empty|bare|اون فرنش\p{L}*)(?: |$)/u;
const SEMI = new RegExp(`(?:^| )(?:نص|نصف|semi|half|سيمي|جزئي|جزيي)[ -]?${FURN}`);
const SEMI_ALT = /(?:^| )(?:نص|نصف) (?:فرش|مفروش)/;
const FURNISHED = new RegExp(`(?:^| )(?:fully |full |كامل )?${FURN}`);

function fold(text) {
  return ` ${norm(text).replace(/[-_/,.،()]+/g, " ").replace(/\s+/g, " ").trim()} `;
}

function readFurnishing(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { value: null, sure: true };
  const t = fold(raw);
  const neg = NEGATED.test(t) || UNFURN_WORDS.test(t);
  const semi = SEMI.test(t) || SEMI_ALT.test(t);
  // Remove negated and semi forms, then look for a plain "furnished".
  const rest = t.replace(new RegExp(`(?:^| )${NEG} ?${FURN}`, "g"), " ").replace(new RegExp(`(?:^| )(?:نص|نصف|semi|half|سيمي|جزئي|جزيي)[ -]?${FURN}`, "g"), " ").replace(UNFURN_WORDS, " ");
  const plain = FURNISHED.test(rest);
  if (neg && plain) return { value: null, sure: false };
  if (semi && plain) return { value: null, sure: false };
  if (semi) return { value: "semi_furnished", sure: true };
  if (neg) return { value: "unfurnished", sure: true };
  if (plain) return { value: "furnished", sure: true };
  const k = KITCHEN.test(t);
  const a = AC.test(t);
  if (k && a) return { value: "kitchen_and_ac", sure: true };
  if (a) return { value: "ac_only", sure: true };
  if (k) return { value: "kitchen_only", sure: true };
  return { value: null, sure: true };
}

module.exports = { readFurnishing };
