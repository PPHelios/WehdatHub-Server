// tests/parsers/regression.test.js — CI guard: every eval case that passed in the baseline must still pass,
// and no NCH query may error. Output is errors only.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { misses } = require("./expect");
const baseline = require("./baseline/search-baseline.json");
const Q = require("../../domain/searchQuery");

test("eval cases that passed in the baseline still pass", () => {
  const lost = [];
  baseline.eval.forEach((b) => {
    if (misses(b.expect, b.got.filters).length) return;
    const now = Q.fallbackParse(b.q).filters;
    const bad = misses(b.expect, now);
    if (bad.length) lost.push(`${b.q} [${bad.join(",")}]`);
  });
  assert.deepEqual(lost, [], `cases that broke: ${lost.join(" | ")}`);
});

test("NCH golden queries do not error", () => {
  const failed = baseline.nch.filter((r) => {
    try {
      Q.fallbackParse(r.q);
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(failed.length, 0, `queries that threw: ${failed.map((r) => r.q).join(" | ")}`);
});

test("no unit newly drops out of its own queries (recall)", () => {
  const Recall = require("./recall");
  const base = new Set(require("./baseline/recall-baseline.json").excluded);
  const now = Recall.run().misses.map((m) => m.key);
  const fresh = now.filter((k) => !base.has(k));
  assert.deepEqual(fresh.slice(0, 20), [], `${fresh.length} new misses, first: ${fresh.slice(0, 20).join(" ")}`);
});
