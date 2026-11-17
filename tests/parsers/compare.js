// tests/parsers/compare.js — Compares two snapshots (old vs new) and prints only the differences.
// Eval cases with an "expect" are scored: a case that passed before and fails now is a REGRESSION;
// one that failed before and passes now is FIXED. Any other output change on any query is CHANGED (review).
// Usage: node tests/parsers/compare.js <old.json> <new.json>   (exit code 1 when there is any regression)
"use strict";

const fs = require("fs");
const { misses } = require("./expect");

const [oldFile, newFile] = process.argv.slice(2);
if (!oldFile || !newFile) {
  console.error("usage: node tests/parsers/compare.js <old.json> <new.json>");
  process.exit(2);
}
const before = JSON.parse(fs.readFileSync(oldFile, "utf8"));
const after = JSON.parse(fs.readFileSync(newFile, "utf8"));

const fixed = [];
const regression = [];
const changed = [];

before.eval.forEach((b, i) => {
  const a = after.eval[i];
  const passBefore = misses(b.expect, b.got.filters).length === 0;
  const passAfter = misses(a.expect, a.got.filters).length === 0;
  if (passBefore && !passAfter) regression.push({ q: a.q, miss: misses(a.expect, a.got.filters) });
  else if (!passBefore && passAfter) fixed.push({ q: a.q });
  else if (JSON.stringify(b.got) !== JSON.stringify(a.got)) changed.push({ q: a.q });
});

before.nch.forEach((b, i) => {
  const a = after.nch[i];
  if (JSON.stringify(b.got) !== JSON.stringify(a.got)) changed.push({ q: a.q });
});

const passCount = (rows) => rows.filter((r) => misses(r.expect, r.got.filters).length === 0).length;
console.log(`eval pass: ${passCount(before.eval)} -> ${passCount(after.eval)} of ${before.eval.length}`);
console.log(`fixed: ${fixed.length}, regression: ${regression.length}, changed (review): ${changed.length}`);
for (const r of regression) console.log(`REGRESSION ${r.q} miss=${r.miss.join(",")}`);
for (const c of changed) console.log(`CHANGED ${c.q}`);
process.exit(regression.length ? 1 : 0);
