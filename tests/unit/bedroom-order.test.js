// tests/unit/bedroom-order.test.js — An exact bedroom count sorts first (2 bedrooms, then 3 and above, then the rest).
"use strict";

const S = require("../../lib/search");

describe("search: exact bedroom count sorts first", () => {
  it("puts the asked count first, then larger counts, then near matches", () => {
    const parsed = S.fallbackParse("شقة 2 غرف");
    const { sql } = S.buildSearchQuery("agency-id", parsed, { limit: 5, offset: 0 });
    expect(sql).toMatch(/CASE WHEN l\.bedrooms - \$\d+ = 0 THEN 0 WHEN l\.bedrooms - \$\d+ > 0 THEN l\.bedrooms - \$\d+ ELSE 100 END/);
  });

  it("adds no bedroom order for a range (2 to 3 bedrooms)", () => {
    const parsed = { filters: { bedrooms_min: 2, bedrooms_max: 3 } };
    const { sql } = S.buildSearchQuery("agency-id", parsed, { limit: 5, offset: 0 });
    expect(sql).not.toMatch(/THEN 0 WHEN l\.bedrooms > /);
  });
});
