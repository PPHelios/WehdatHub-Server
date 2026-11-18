// tests/unit/unit-filters.test.js — One reader for the units list's filters (domain/unitFilters.js), used by the website and the app.
"use strict";

const F = require("../../domain/unitFilters");

test("read cleans every filter and keeps private for the owner only", () => {
  const f = F.read({ type: "apartment", finishing: "none", furnishing: "bogus", deal: "rent", pmin: "3m", bedrooms: "3", q: "HP%", private: "1", old: "1" }, { isOwner: false, status: "active" });
  expect(f).toMatchObject({ type: "apartment", finishing: "none", furnishing: "", deal: "rent", bedrooms: 3, q: "HP%", onlyPrivate: false, old: true });
  expect(F.read({ private: "1" }, { isOwner: true }).onlyPrivate).toBe(true);
  expect(F.read({ old: "1" }, { status: "sold" }).old).toBe(false);
});

test("conditions number their values after the caller's own", () => {
  const f = F.read({ type: "villa", pmin: "5,000,000", q: "A_1", finishing: "none" });
  const where = ["agency_id = $1"];
  const args = ["agency"];
  F.appendTo(where, args, F.conditions(f, { brokerId: "b1", alias: "listings", compound: "Mivida" }));
  expect(where).toContain("listings.compound = $2");
  expect(where).toContain("listings.property_type = $3");
  expect(where).toContain("listings.finishing IS NULL");
  expect(where.join(" ")).toMatch(/listings\.price_value >= \$4/);
  const esc = "A\\_1"; // the _ is escaped for ILIKE
  expect(args).toEqual(["agency", "Mivida", "villa", 5000000, esc, esc, esc]);
});
