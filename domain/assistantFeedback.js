// domain/assistantFeedback.js — Scrubs a question before it is stored as an assistant miss: no phone numbers, no emails.
"use strict";

const toLatinDigits = (s) => s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0));

/** Emails -> "@", phone-like numbers (Egyptian mobile 01[0125]x, 201x, +20x, 0020x; spaces/dashes allowed) -> "#"; prices stay, capped at 200 characters. */
function scrubQuestion(text) {
  return toLatinDigits(String(text || ""))
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "@")
    .replace(/(?<!\d)(?:(?:\+|00)[\s-]?)?(?:20[\s-]?)?0?1[0125](?:[\s-]?\d){8}(?!\d)/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

module.exports = { scrubQuestion };
