// tests/web/plan-refusal-text.test.js — QA round 4 #93: a blocked account says it is stopped until renewal (not read-only);
// read-only keeps its own text; a broker is told to ask the manager in both.
"use strict";

const PlanGuard = require("../../lib/planGuard");

const manager = { role: "manager" };
const broker = { role: "broker" };

test("blocked says stopped until the plan is renewed, for a manager and for a broker", () => {
  for (const lang of ["en", "ar"]) {
    for (const who of [manager, broker]) {
      const t = PlanGuard.refusalText({ source: "blocked" }, lang, who);
      expect(t).not.toMatch(/read-only|للقراءة بس/);
    }
  }
  expect(PlanGuard.refusalText({ source: "blocked" }, "en", manager)).toMatch(/stopped until the plan is renewed/);
  expect(PlanGuard.refusalText({ source: "blocked" }, "en", broker)).toMatch(/stopped until the plan is renewed.*Ask your manager/);
  expect(PlanGuard.refusalText({ source: "blocked" }, "ar", broker)).toMatch(/متوقف لحد ما الباقة تتجدّد.*مديرك/);
});

test("read-only keeps its own text", () => {
  expect(PlanGuard.refusalText({ source: "readonly" }, "en", broker)).toMatch(/read-only right now.*Ask your manager/);
  expect(PlanGuard.refusalText({ source: "readonly" }, "en", manager)).toMatch(/read-only/);
});
