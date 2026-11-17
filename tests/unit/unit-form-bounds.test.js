// tests/unit/unit-form-bounds.test.js — values that cannot be real are not stored as real (found by QA 2026-11-17:
// a price of "-5" was saved as 5, and 99 bedrooms was accepted). Shared by the website form and the app's API.
"use strict";

const Form = require("../../web/forms/unitForm");

test("a negative price is not a price", () => {
  expect(Form.unitFromForm({ price_value: "-5" }).price_value).toBe(null);
  expect(Form.unitFromForm({ price_value: "-3,500,000" }).price_value).toBe(null);
  expect(Form.unitFromForm({ price_value: "−2 مليون" }).price_value).toBe(null);
});

test("normal prices still read as before", () => {
  expect(Form.unitFromForm({ price_value: "3500000" }).price_value).toBe(3500000);
  expect(Form.unitFromForm({ price_value: "4.2 مليون" }).price_value).toBe(4200000);
  expect(Form.unitFromForm({ price_value: "750 الف" }).price_value).toBe(750000);
  expect(Form.unitFromForm({ price_value: "9,500,000" }).price_value).toBe(9500000);
});

test("bedrooms and bathrooms outside 0 to 30 are treated as not given", () => {
  expect(Form.unitFromForm({ bedrooms: "99" }).bedrooms).toBe(null);
  expect(Form.unitFromForm({ bedrooms: "-1" }).bedrooms).toBe(null);
  expect(Form.unitFromForm({ bathrooms: "500" }).bathrooms).toBe(null);
  expect(Form.unitFromForm({ bedrooms: "3", bathrooms: "2" })).toMatchObject({ bedrooms: 3, bathrooms: 2 });
  expect(Form.unitFromForm({ bedrooms: "0" }).bedrooms).toBe(0);
});
