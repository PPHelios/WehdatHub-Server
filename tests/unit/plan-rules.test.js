// Plan rules (custom plan calculator, step 1): cleaning the form and checking a plan against the limits.
"use strict";
const R = require("../../services/planRules");

test("cleanRules keeps only valid frequencies and fees with an amount", () => {
  const out = R.cleanRules({ min_down_payment_pct: "10", frequencies: ["quarterly", "bogus"], fee_label: ["Garage", ""], fee_amount: ["50000", ""], fee_due: ["delivery", ""] });
  expect(out.rules.min_down_payment_pct).toEqual(10);
  expect(out.rules.frequencies).toEqual(["quarterly"]);
  expect(out.rules.optional_fees).toEqual([{ label: "Garage", amount: 50000, due: "delivery" }]);
});

test("cleanRules rejects out-of-range limits", () => {
  expect(R.cleanRules({ max_years: "25" }).error).toEqual("max_years");
  expect(R.cleanRules({ min_down_payment_pct: "120" }).error).toEqual("min_down_payment_pct");
});

test("checkPlan flags a plan outside the limits and passes one inside", () => {
  const rules = { min_down_payment_pct: 10, max_years: 8, frequencies: ["quarterly"] };
  expect(R.checkPlan(rules, { down_payment_pct: 5, years: 9, frequency: "monthly" }).reasons).toEqual(["down_payment", "years", "frequency"]);
  expect(R.checkPlan(rules, { down_payment_pct: 10, years: 8, frequency: "quarterly" }).exception).toEqual(false);
});

test("a project with no rules has no exceptions", () => {
  expect(R.checkPlan({}, { down_payment_pct: 0, years: 20, frequency: "monthly" }).exception).toEqual(false);
});
