// tests/unit/ownerAlerts.test.js — lib/ownerAlerts.js: the CRM owner's category switches and minimum severity.
"use strict";

const OwnerAlerts = require("../../lib/ownerAlerts");
const Billing = require("../../services/billing");

const poolWith = (value) => ({ query: jest.fn().mockResolvedValue({ rows: value === undefined ? [] : [{ value }] }) });
beforeEach(() => OwnerAlerts.invalidate());

test("default: every category is allowed", async () => {
  const pool = poolWith(undefined);
  for (const c of OwnerAlerts.CATEGORIES) expect(await OwnerAlerts.allowed(pool, c.id)).toBe(true);
});

test("a category switched off is not allowed, the others are", async () => {
  const pool = poolWith({ off: ["storage"], minSeverity: "low" });
  expect(await OwnerAlerts.allowed(pool, "storage")).toBe(false);
  expect(await OwnerAlerts.allowed(pool, "errors")).toBe(true);
});

test("minSeverity high hides medium and low, never high", async () => {
  const pool = poolWith({ off: [], minSeverity: "high" });
  for (const c of OwnerAlerts.CATEGORIES) expect(await OwnerAlerts.allowed(pool, c.id)).toBe(c.severity === "high");
  OwnerAlerts.invalidate();
  const mid = poolWith({ off: [], minSeverity: "medium" });
  for (const c of OwnerAlerts.CATEGORIES) expect(await OwnerAlerts.allowed(mid, c.id)).toBe(c.severity !== "low");
});

test("an unknown category or a broken database never blocks an alert", async () => {
  expect(await OwnerAlerts.allowed(poolWith({ off: ["errors"] }), "nope")).toBe(true);
  expect(await OwnerAlerts.allowed({ query: jest.fn().mockRejectedValue(new Error("db down")) }, "errors")).toBe(true);
  expect(await OwnerAlerts.allowed(null, "errors")).toBe(true);
});

test("settings are cached for 30 seconds and save clears the cache; junk is cleaned", async () => {
  const pool = poolWith({ off: ["places"] });
  await OwnerAlerts.allowed(pool, "places");
  await OwnerAlerts.allowed(pool, "places");
  expect(pool.query).toHaveBeenCalledTimes(1);
  const saved = await OwnerAlerts.save({ query: jest.fn().mockResolvedValue({}) }, { off: ["errors", "bogus", "errors"], minSeverity: "weird" });
  expect(saved).toEqual({ off: ["errors"], minSeverity: "low" });
  expect(Billing.setSetting).toBeDefined();
  await OwnerAlerts.allowed(pool, "places");
  expect(pool.query).toHaveBeenCalledTimes(2);
});

test("every category has a severity and both labels", () => {
  for (const c of OwnerAlerts.CATEGORIES) {
    expect(OwnerAlerts.SEVERITIES).toContain(c.severity);
    expect(c.ar && c.en).toBeTruthy();
  }
});
