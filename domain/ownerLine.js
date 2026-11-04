// domain/ownerLine.js — The owner written on one line of a unit draft: "مالك"/"المالك" or "Owner", then the name and the number (pure)
"use strict";

const Phone = require("./phone");

const KEYWORD = /^\s*(?:owner|المالك|مالك)(?:\s*[:：\-–]\s*|\s+)(.+)$/iu;
const PHONE_RUN = /\+?\d[\d \-]{7,}\d/;

/**
 * The owner from the first draft line that has the keyword and a phone number, or null.
 * The name is what is left on the line once the phone is taken out. A line without a phone or
 * without a letter in the name is not an owner line (so "مالك الوحدة مستعجل" is still unit text).
 * @returns {{ name: string, phone: string } | null} phone in the stored digits form (e.g. 201065358746)
 */
function parseOwnerLine(texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  for (const block of list) {
    for (const line of String(block ?? "").split(/\r?\n/)) {
      const m = line.match(KEYWORD);
      if (!m) continue;
      const rest = m[1].replace(/[٠-٩]/g, (c) => String("٠١٢٣٤٥٦٧٨٩".indexOf(c)));
      const run = rest.match(PHONE_RUN);
      const phone = run ? Phone.normalizePhone(run[0]) : null;
      if (!phone) continue;
      const name = rest.replace(run[0], " ").replace(/[,،|;:()\[\]]+/g, " ").replace(/\s+/g, " ").replace(/^[\s\-–]+|[\s\-–]+$/g, "");
      if (!name || !/\p{L}/u.test(name)) continue;
      return { name: name.slice(0, 120), phone };
    }
  }
  return null;
}

module.exports = { parseOwnerLine };
