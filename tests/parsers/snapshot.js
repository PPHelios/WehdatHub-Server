// tests/parsers/snapshot.js — Runs the search parser on every eval case and every NCH golden query,
// and writes the output as JSON. Used as the baseline (before a change) and the new run (after it).
// Usage: node tests/parsers/snapshot.js <out.json>
"use strict";

const fs = require("fs");
const path = require("path");
const Q = require("../../domain/searchQuery");

const root = path.join(__dirname, "..", "..");
const evalCases = require(path.join(root, "tests/eval/search-egyptian-cases.json"));
const golden = require(path.join(__dirname, "golden-nch-queries.json"));

const parse = (q) => {
  try {
    return { filters: Q.fallbackParse(q).filters };
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) };
  }
};

const out = {
  eval: evalCases.map((c) => ({ q: c.q, expect: c.expect, got: parse(c.q) })),
  nch: golden.map((q) => ({ q, got: parse(q) }))
};

const target = process.argv[2];
if (!target) {
  console.error("usage: node tests/parsers/snapshot.js <out.json>");
  process.exit(1);
}
fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
fs.writeFileSync(target, JSON.stringify(out, null, 1) + "\n");
const errors = [...out.eval, ...out.nch].filter((r) => r.got.error).length;
console.log(`snapshot: ${out.eval.length} eval cases, ${out.nch.length} NCH queries, ${errors} errors`);
