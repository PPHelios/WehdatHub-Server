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

test("a unit card says for sale or for rent", () => {
  const { resultItem } = require("../../web/views/units");
  const base = { id: "1", code: "A1", property_type: "apartment", price_value: 1000000, details: {} };
  expect(String(resultItem({ ...base, listing_type: "rent" }, "en"))).toMatch(/For rent/);
  expect(String(resultItem({ ...base, listing_type: "sale" }, "ar"))).toMatch(/للبيع/);
});

test("Franco-Arabic and attached words are read", () => {
  const f = Q.fallbackParse("shaqa 3 ghorf ejar fe mivida").filters;
  expect([f.listing_type, f.property_types, f.bedrooms_min]).toEqual(["rent", ["apartment"], 3]);
  expect(Q.fallbackParse("شقة للبيع في مفيدا").filters.places.map((p) => p.key)).toEqual(["mivida"]);
});

test("the Telegram Main button never picks a button inside a closed box", () => {
  const fs = require("fs");
  expect(fs.readFileSync("web/static/app.js", "utf8")).toMatch(/closest\("details:not\(\[open\]\)"\)/);
  expect(fs.readFileSync("web/routes/search.js", "utf8")).toMatch(/<button type="submit" data-no-tg-main>/);
});
