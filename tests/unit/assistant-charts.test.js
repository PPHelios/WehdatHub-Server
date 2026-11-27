// tests/unit/assistant-charts.test.js — pure builders for the assistant's chart cards.
"use strict";
const C = require("../../domain/assistantCharts");

test("trend: direction from the last point vs the earlier average, with summary", () => {
  const up = C.trendCard({ title: "Leads", points: [2, 3, 2, 3, 9].map((value, i) => ({ label: `w${i}`, value })), en: true });
  expect(up).toMatchObject({ kind: "trend", direction: "rising", directionLabel: "Rising" });
  expect(up.summary).toMatch(/Leads: Rising \(\+/);
  expect(C.trendCard({ title: "t", points: [5, 5, 5, 5].map((value) => ({ label: "", value })), en: false }).direction).toBe("flat");
  expect(C.trendCard({ title: "t", points: [10, 10, 10, 2].map((value) => ({ label: "", value })), en: true }).direction).toBe("falling");
  expect(C.trendCard({ title: "t", points: [{ label: "a", value: 1 }], en: true })).toBeNull();
});

test("share: percentages, drops zero parts, needs two parts", () => {
  const c = C.shareCard({ title: "Won vs lost", parts: [{ label: "Won", value: 3 }, { label: "Lost", value: 1 }, { label: "None", value: 0 }], en: true });
  expect(c.parts.map((p) => p.pct)).toEqual([75, 25]);
  expect(c.summary).toBe("Won vs lost: Won 75%, Lost 25%");
  expect(C.shareCard({ title: "x", parts: [{ label: "a", value: 4 }], en: true })).toBeNull();
});

test("price_range: histogram counts, median, budget pill", () => {
  const c = C.priceRangeCard({ title: "Prices", place: "X", prices: [1e6, 2e6, 2e6, 3e6, 4e6, 5e6], budget: 4e6, en: false });
  expect(c.bins.reduce((s, b) => s + b.count, 0)).toBe(6);
  expect(c).toMatchObject({ min: 1e6, max: 5e6, median: 2e6, budget: { value: 4e6, label: "ميزانية العميل 4م" } });
  expect(C.priceRangeCard({ title: "p", prices: [1, 2], en: true })).toBeNull();
});

test("compare: best per row, price/m2 only for EGP sale, missing stays null", () => {
  const u = (code, price, area, extra = {}) => ({ code, price_value: price, area_value: area, listing_type: "sale", ...extra });
  const c = C.compareCard({ units: [u("A1", 5e6, 100, { finishing: "full" }), u("B2", 4e6, 80)], en: true });
  const row = (k) => c.rows.find((r) => r.key === k);
  expect(row("price").best).toBe(1);
  expect(row("area").best).toBe(0);
  expect(row("ppm2").values).toEqual(["50,000", "50,000"]);
  expect(row("ppm2").best).toBeNull();
  expect(row("finishing").values).toEqual(["full", null]);
  const usd = C.compareCard({ units: [u("A", 1, 10, { currency: "USD" }), u("B", 2, 20)], en: true });
  expect(usd.rows.find((r) => r.key === "ppm2")).toBeUndefined();
  expect(C.compareCard({ units: [u("A", 1, 1)], en: true })).toBeNull();
});

test("bar summary lists rows", () => {
  expect(C.barSummary("T", [{ label: "a", count: 2 }, { label: "b", count: 1, valueLabel: "1 x" }], true)).toBe("T: a 2, b 1 x");
});
