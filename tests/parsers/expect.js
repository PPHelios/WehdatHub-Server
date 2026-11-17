// tests/parsers/expect.js — Scores parsed search filters against an eval case's "expect" block.
// Returns the expectation keys that do not match (empty array = pass).
"use strict";

const SUBSET_KEYS = new Set(["property_types", "features", "finishing", "furnishing", "feature_terms", "place_terms"]);

function misses(expect, filters) {
  const bad = [];
  for (const [k, v] of Object.entries(expect || {})) {
    const g = filters?.[k];
    if (k === "places") {
      const keys = (g || []).map((p) => p.key);
      if (!v.every((x) => keys.includes(x))) bad.push(k);
    } else if (SUBSET_KEYS.has(k) && Array.isArray(v)) {
      const have = Array.isArray(g) ? g : [];
      if (!v.every((x) => have.includes(x))) bad.push(k);
    } else if (JSON.stringify(g) !== JSON.stringify(v)) {
      bad.push(k);
    }
  }
  return bad;
}

module.exports = { misses };
