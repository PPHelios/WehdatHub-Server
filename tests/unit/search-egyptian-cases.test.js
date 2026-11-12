// The Egyptian Arabic / English / Franco search set (tests/eval/search-egyptian-cases.json).
// Each case is a request and the filters the quick reader must read from it. A case marked "gap" is a known miss: it is counted in
// the accuracy score, must still be wrong (when it starts passing the test says to remove the mark), and never fails the build.
// Every wrong search a broker reports becomes a case here. The floor only goes up: raise MIN_ACCURACY as gaps are fixed.
"use strict";
const Q = require("../../domain/searchQuery");
const cases = require("../eval/search-egyptian-cases.json");

const MIN_ACCURACY = 0.9;
const KEYS = ["listing_type", "property_types", "price_min", "price_max", "area_min", "area_max", "bedrooms_min", "bedrooms_max", "bathrooms_min", "floor_min", "furnishing", "finishing", "features", "feature_terms", "place_terms", "max_down_payment", "max_installment", "payment_years", "payment_down_pct", "payment_cash", "delivery_ready", "delivery_by_year", "market", "currency", "code", "places"];

const read = (q) => {
  const f = Q.fallbackParse(q).filters;
  return { ...f, places: (f.places || []).map((p) => p.key) };
};
const wrong = (q, expect) => {
  const f = read(q);
  const bad = {};
  for (const k of KEYS) {
    const want = expect[k] === undefined ? (Array.isArray(f[k]) ? [] : null) : expect[k];
    const got = f[k] === undefined || f[k] === false ? (Array.isArray(want) ? [] : null) : f[k];
    if (JSON.stringify(got) !== JSON.stringify(want)) bad[k] = { want, got };
  }
  return bad;
};

describe("Egyptian search set", () => {
  const regular = cases.filter((c) => !c.gap);
  test.each(regular.map((c) => [c.q, c.expect]))("%s", (q, expect) => {
    expect_(wrong(q, expect)).toEqual({});
  });
  test("known gaps are still gaps (a fixed one loses its mark)", () => {
    const fixed = cases.filter((c) => c.gap && Object.keys(wrong(c.q, c.expect)).length === 0).map((c) => c.q);
    expect_(fixed).toEqual([]);
  });
  test(`accuracy stays at ${MIN_ACCURACY * 100}% or more`, () => {
    const ok = cases.filter((c) => Object.keys(wrong(c.q, c.expect)).length === 0).length;
    const acc = ok / cases.length;
    if (acc < MIN_ACCURACY) console.log(`Egyptian search set: ${ok}/${cases.length} = ${(acc * 100).toFixed(1)}%`);
    expect_(acc).toBeGreaterThanOrEqual(MIN_ACCURACY);
  });
});
// jest's `expect` is shadowed by the case's own `expect` argument above.
function expect_(v) {
  return global.expect(v);
}
