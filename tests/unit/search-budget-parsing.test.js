// tests/unit/search-budget-parsing.test.js — Haytham's 2026-11-06 report on flagged searches: a budget with a small plain
// number means thousands of EGP ("budget 50" = 50,000), Arabic-Indic digits count too, and "down payment less than N" sets
// the down-payment cap, not the price.
"use strict";

const Q = require("../../domain/searchQuery");

const read = (text) => Q.fallbackParse(text).filters;

describe("budget with a small plain number", () => {
  // Haytham 2026-11-06: "50" can mean 50 thousand or 50 million, so the price is never guessed. The bot asks which unit.
  test.each([
    ["budget 50", "50"],
    ["بادجيت ١٠٠", "١٠٠"],
    ["budget 2.5", "2.5"]
  ])("%s leaves the price empty and asks for the unit", (text, typed) => {
    const parsed = Q.fallbackParse(text);
    expect(parsed.filters.price_max).toBeNull();
    expect(parsed.filters.price_min).toBeNull();
    const ask = parsed.meta.ambiguous.find((a) => a.kind === "budget");
    expect(ask).toBeDefined();
    expect(ask.typed).toBe(typed);
    expect(ask.options).toHaveLength(2);
  });

  test("rent offers thousands first, sale offers millions first", () => {
    const rent = Q.fallbackParse("شقة للايجار budget 50").meta.ambiguous.find((a) => a.kind === "budget");
    const sale = Q.fallbackParse("شقة للبيع budget 2.5").meta.ambiguous.find((a) => a.kind === "budget");
    expect(rent.options[0]).toMatch(/ألف/);
    expect(sale.options[0]).toMatch(/مليون/);
  });

  test("a budget with a full amount and dollar sign is unchanged", () => {
    const f = read("budget 5000$");
    expect(f.price_max).toBe(5000);
    expect(f.currency).toBe("USD");
  });

  test("a budget with four digits is not cut to three", () => {
    expect(read("budget 5000").price_max).toBe(5000);
  });
});

describe("down payment limit words", () => {
  test("down payment less than 1 million sets the down-payment cap, not the price", () => {
    const f = read("down payment less than 1 million");
    expect(f.max_down_payment).toBe(1000000);
    expect(f.price_max).toBeNull();
  });

  test("down payment under the same amount still works", () => {
    const f = read("مقدم اقل من 500 الف");
    expect(f.max_down_payment).toBe(500000);
    expect(f.price_max).toBeNull();
  });
});
