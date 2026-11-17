// tests/unit/deal-form-negative.test.js — a negative price is refused as a price (QA 2026-11-17: "-5" was read as 5 and the
// message said "The commission is more than the price").
"use strict";

const { inputFromForm } = require("../../lib/dealForm");
const Commission = require("../../domain/commission");

const compute = (body) => {
  const i = inputFromForm(body, { role: "owner" });
  return Commission.compute({ price: i.price, mode: i.mode, pct: i.pct, amount: i.amount, closingBrokerId: "b1" }).errors;
};

test("a negative price is reported as a price problem", () => {
  expect(compute({ lead: "L-1", price: "-5", commission: "100" })[0]).toBe("price");
  expect(compute({ lead: "L-1", price: "−3,000,000", commission: "2%" })[0]).toBe("price");
});

test("normal deals still compute", () => {
  expect(compute({ lead: "L-1", price: "3000000", commission: "2%" })).toEqual([]);
  expect(compute({ lead: "L-1", price: "3 مليون", commission: "60000" })).toEqual([]);
});
