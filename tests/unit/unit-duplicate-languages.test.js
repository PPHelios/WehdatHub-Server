// tests/unit/unit-duplicate-languages.test.js — QA round 2 (item 49): the duplicate check matches the same compound typed in
// English and stored in Arabic (found: "Mivida" vs "ميفيدا" was not flagged).
"use strict";

const D = require("../../domain/unitDuplicate");

const base = { listing_type: "sale", bedrooms: 2, property_type: "apartment", area_value: 120, price_value: 3500000 };

test("the same compound in two languages is the same place", () => {
  expect(D.sameUnit({ ...base, compound: "Mivida", compound_en: "Mivida" }, { ...base, compound: "ميفيدا", compound_en: "Mivida" })).toBe(true);
  expect(D.sameUnit({ ...base, compound: "ميفيدا", compound_en: "Mivida" }, { ...base, compound: "Mivida" })).toBe(true);
});

test("a different compound, or numbers too far apart, is not a duplicate", () => {
  expect(D.sameUnit({ ...base, compound: "Hyde Park", compound_en: "Hyde Park" }, { ...base, compound: "ميفيدا", compound_en: "Mivida" })).toBe(false);
  expect(D.sameUnit({ ...base, compound: "Mivida", compound_en: "Mivida" }, { ...base, price_value: 6000000, compound: "ميفيدا", compound_en: "Mivida" })).toBe(false);
});

test("same spelling still matches", () => {
  expect(D.sameUnit({ ...base, compound: "Mivida" }, { ...base, compound: "Mivida" })).toBe(true);
});
