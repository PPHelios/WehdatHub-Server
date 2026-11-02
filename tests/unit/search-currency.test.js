// tests/unit/search-currency.test.js — Dollar and euro prices (domain/fx.js). A dollar or euro unit and budget are
// compared in EGP using the agency's rate; with no rate set, they match no price.
"use strict";

const Q = require("../../domain/searchQuery");
const F = require("../../domain/fx");
const Search = require("../../services/search");

const read = (text) => Q.fallbackParse(text).filters;

describe("rates", () => {
  test("a usable rate is a number from 1 to 1000; blank is not set; anything else is refused", () => {
    expect(F.parseRate("52")).toBe(52);
    expect(F.parseRate("52.456")).toBe(52.46);
    expect(F.parseRate("")).toBeNull();
    expect(F.parseRate("abc")).toBeUndefined();
    expect(F.parseRate("0")).toBeUndefined();
    expect(F.parseRate("5000")).toBeUndefined();
  });

  test("1000 dollars is 52000 EGP at 52, and a missing rate gives no EGP value", () => {
    expect(F.toEgp(1000, "USD", { USD: 52, EUR: null })).toBe(52000);
    expect(F.toEgp(1000, "EUR", { USD: 52, EUR: null })).toBeNull();
    expect(F.toEgp(1000, "EGP", { USD: null, EUR: null })).toBe(1000);
  });
});

describe("the parser keeps the currency", () => {
  test.each([
    ["شقة تحت 20 ألف دولار", "USD", 20000],
    ["under 1000 dollars apartment", "USD", 1000],
    ["$20k", "USD", 20000],
    ["€15k flat", "EUR", 15000],
    ["شقة تحت 20 ألف يورو", "EUR", 20000],
    ["apartment under 20k", null, 20000]
  ])("%s", (text, currency, max) => {
    const f = read(text);
    expect(f.currency).toBe(currency);
    expect(f.price_max).toBe(max);
    expect(f.place_terms).toEqual([]);
  });
});

describe("prices are compared in EGP", () => {
  test("a dollar budget converts with the agency rate", () => {
    const { sql, params } = Search.buildSearchQuery("agency", { filters: read("under 1000 dollars apartment") }, { fx: { USD: 52, EUR: null } });
    expect(sql).toMatch(/CASE coalesce\(l\.details->>'currency', 'EGP'\)/);
    expect(params).toContain(52);
    expect(params).toContain(52000);
  });

  test("a dollar budget with no rate matches no price", () => {
    const { sql } = Search.buildSearchQuery("agency", { filters: read("under 1000 dollars apartment") }, { fx: { USD: null, EUR: null } });
    expect(sql).toMatch(/AND FALSE/);
  });

  test("no currency keeps the plain EGP budget, with no conversion", () => {
    const { params } = Search.buildSearchQuery("agency", { filters: read("apartment under 20k") }, { fx: {} });
    expect(params).toContain(20000);
  });
});
