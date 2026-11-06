// tests/unit/search-recheck-gate.test.js — "All handled" on Repeat offenders needs a saved test case and a clean reading (Haytham 2026-11-06).
"use strict";

const Review = require("../../services/searchReview");

const pool = (hasCase) => ({ query: jest.fn(async () => ({ rowCount: hasCase ? 1 : 0 })) });

describe("re-check before All handled", () => {
  test("blocked when there is no test case", async () => {
    const r = await Review.recheck(pool(false), "شقة 3 غرف في التجمع");
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("test_case");
  });

  test("blocked when the parser still has an open question", async () => {
    const r = await Review.recheck(pool(true), "budget 50");
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("parser");
  });

  test("passes when a test case exists and the reading is clean", async () => {
    const r = await Review.recheck(pool(true), "شقة 3 غرف في التجمع");
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });
});
