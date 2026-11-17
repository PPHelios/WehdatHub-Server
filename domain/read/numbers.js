// domain/read/numbers.js — Shared number helpers for every text reader (digits, Arabic number words, text clean-up).
// Pure. No network, no DB. Used by amount.js, rooms.js, area.js, floor.js (Parser consolidation, Phase 1).
"use strict";

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

function toAsciiDigits(s) {
  return String(s ?? "")
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
    .replace(/٫/g, ".")
    .replace(/[،٬]/g, ",");
}

// One clean form for matching: ASCII digits, no diacritics or tatweel, alef/ya/ta-marbuta folded, lower case.
// Keyword lists in the readers are written in this folded form (e.g. "غرفه", "الف", "الا").
function norm(s) {
  return toAsciiDigits(s)
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase();
}

// Number words (already folded). Egyptian and standard forms.
const WORDS = {
  واحد: 1, واحده: 1, اتنين: 2, اثنين: 2, اثنان: 2, اتنان: 2, ثنتين: 2,
  تلاته: 3, ثلاثه: 3, تلات: 3, ثلاث: 3, اربعه: 4, اربع: 4, خمسه: 5, خمس: 5,
  سته: 6, ست: 6, سبعه: 7, سبع: 7, تمانيه: 8, ثمانيه: 8, تمن: 8, ثمان: 8, تسعه: 9, تسع: 9,
  عشره: 10, عشر: 10, حداشر: 11, احداشر: 11, اتناشر: 12, اثناعشر: 12, تلتاشر: 13, اربعتاشر: 14,
  خمستاشر: 15, ستاشر: 16, سبعتاشر: 17, تمنتاشر: 18, تسعتاشر: 19,
  عشرين: 20, تلاتين: 30, ثلاثين: 30, اربعين: 40, خمسين: 50, ستين: 60, سبعين: 70,
  تمانين: 80, ثمانين: 80, تسعين: 90, ميه: 100, مايه: 100, مائه: 100, ميت: 100,
};

function wordValue(w) {
  const v = WORDS[norm(w)];
  return v === undefined ? null : v;
}

const WORD_ALT = Object.keys(WORDS)
  .sort((a, b) => b.length - a.length)
  .join("|");

module.exports = { toAsciiDigits, norm, WORDS, WORD_ALT, wordValue };
