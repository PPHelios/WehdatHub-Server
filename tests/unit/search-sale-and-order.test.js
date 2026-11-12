"use strict";
const Q = require("../../domain/searchQuery");
const Search = require("../../services/search");
const { formatInterpretation } = require("../../lib/search");
const ViewGuard = require("../../lib/viewGuard");

test("a down payment with no rent word is a sale", () => {
  const p = Q.enforceSaleForPayment({ filters: { ...Q.emptyFilters(), listing_type: "rent", max_down_payment: 500000 } }, "شقة نص مليون مقدم");
  expect(p.filters.listing_type).toBe("sale");
  const r = Q.enforceSaleForPayment({ filters: { ...Q.emptyFilters(), listing_type: "rent", max_down_payment: 500000 } }, "شقة للايجار مقدم 500 الف");
  expect(r.filters.listing_type).toBe("rent");
});

test("the reading always says sale or rent", () => {
  const f = { ...Q.emptyFilters(), property_types: ["apartment"], price_max: 20000000 };
  expect(formatInterpretation({ filters: f }, "en")).toMatch(/sale or rent/);
  expect(formatInterpretation({ filters: { ...f, listing_type: "sale" } }, "en")).not.toMatch(/sale or rent/);
});

test("a price lists the cheapest first", () => {
  const { sql } = Search.buildSearchQuery("a", { filters: { ...Q.emptyFilters(), price_max: 20000000 } }, { limit: 5 });
  expect(sql).toMatch(/l\.price_value ASC NULLS LAST/);
});

test("currency unset vs EGP is not a disagreement", () => {
  const a = { filters: { ...Q.emptyFilters(), currency: null } };
  const b = { filters: { ...Q.emptyFilters(), currency: "EGP" } };
  expect(Q.disagreements(a, b)).not.toContain("currency");
});

test("the search log can write through the read-only view", async () => {
  const seen = [];
  await ViewGuard.runWritable(async () => seen.push(ViewGuard.active()));
  expect(seen).toEqual([false]);
});
