// tests/parsers/money-diff.js — Old money readers vs the wrapped ones, on every text we have (Phase 1 gate).
// Prints only differences, grouped: SAME (count only), FIXED (in tests/parsers/money-cases.json "expect"),
// REGRESSION (old matched the expectation, new does not), CHANGED (no expectation; review).
// Usage: node tests/parsers/money-diff.js   (exit 1 on any regression)
"use strict";

const T = require("../../lib/text");
const cases = require("./money-cases.json");
const evalCases = require("../eval/search-egyptian-cases.json");
const golden = require("./golden-nch-queries.json");

const expected = new Map(cases.map((c) => [c.text, c.value]));
const texts = [...new Set([...cases.map((c) => c.text), ...evalCases.map((c) => c.q), ...golden])];

const pick = (fn, t) => {
  try {
    const r = fn(t);
    return r ? (r.value ?? r.priceValue ?? null) : null;
  } catch {
    return "THROW";
  }
};

let same = 0;
const fixed = [];
const regression = [];
const changed = [];
for (const t of texts) {
  for (const [name, oldFn, newFn] of [
    ["parseMoney", T.parseMoneyLegacy, T.parseMoney],
    ["parseEgyptianPrice", T.parseEgyptianPriceLegacy, T.parseEgyptianPrice],
  ]) {
    const o = pick(oldFn, t);
    const n = pick(newFn, t);
    if (o === n) {
      same++;
      continue;
    }
    const want = expected.get(t);
    const row = `${name} "${t}": ${o} -> ${n}${want !== undefined ? ` (want ${want})` : ""}`;
    if (want === undefined) changed.push(row);
    else if (n === want) fixed.push(row);
    else if (o === want) regression.push(row);
    else changed.push(row);
  }
}
console.log(`texts: ${texts.length}, same: ${same}, fixed: ${fixed.length}, regression: ${regression.length}, changed: ${changed.length}`);
regression.forEach((r) => console.log("REGRESSION " + r));
changed.forEach((r) => console.log("CHANGED " + r));
if (process.argv.includes("--fixed")) fixed.forEach((r) => console.log("FIXED " + r));
process.exit(regression.length ? 1 : 0);
