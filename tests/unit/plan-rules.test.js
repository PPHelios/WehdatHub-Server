// Plan rules (custom plan calculator, step 1): cleaning the form and checking a plan against the limits.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../../services/planRules");

test("cleanRules keeps only valid frequencies and fees with an amount", () => {
  const out = R.cleanRules({ min_down_payment_pct: "10", frequencies: ["quarterly", "bogus"], fee_label: ["Garage", ""], fee_amount: ["50000", ""], fee_due: ["delivery", ""] });
  assert.equal(out.rules.min_down_payment_pct, 10);
  assert.deepEqual(out.rules.frequencies, ["quarterly"]);
  assert.deepEqual(out.rules.optional_fees, [{ label: "Garage", amount: 50000, due: "delivery" }]);
});

test("cleanRules rejects out-of-range limits", () => {
  assert.equal(R.cleanRules({ max_years: "25" }).error, "max_years");
  assert.equal(R.cleanRules({ min_down_payment_pct: "120" }).error, "min_down_payment_pct");
});

test("checkPlan flags a plan outside the limits and passes one inside", () => {
  const rules = { min_down_payment_pct: 10, max_years: 8, frequencies: ["quarterly"] };
  assert.deepEqual(R.checkPlan(rules, { down_payment_pct: 5, years: 9, frequency: "monthly" }).reasons, ["down_payment", "years", "frequency"]);
  assert.equal(R.checkPlan(rules, { down_payment_pct: 10, years: 8, frequency: "quarterly" }).exception, false);
});

test("a project with no rules has no exceptions", () => {
  assert.equal(R.checkPlan({}, { down_payment_pct: 0, years: 20, frequency: "monthly" }).exception, false);
});
