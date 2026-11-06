// tests/unit/search-budget-parsing.test.js — Haytham's 2026-11-06 report on flagged searches: a budget with a small plain
// number means thousands of EGP ("budget 50" = 50,000), Arabic-Indic digits count too, and "down payment less than N" sets
// the down-payment cap, not the price.
"use strict";

const Q = require("../../domain/searchQuery");

const read = (text) => Q.fallbackParse(text).filters;

describe("budget with a small plain number", () => {
  test.each([
    ["budget 50", 50000],
    ["بادجيت ١٠٠", 100000],
    ["عايز شقة budget 70", 70000]
  ])("%s reads as a price ceiling of %i", (text, expected) => {
    const f = read(text);
    expect(f.price_max).toBe(expected);
    expect(f.price_min).toBeNull();
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
