// tests/unit/form-checks-invalid.test.js — a value that was typed but cannot be read says what is wrong; an empty one stays
// a plain "needed" (QA round 2, items 12 and 14).
"use strict";

const FormChecks = require("../../lib/formChecks");

const price = { field: "price_value", label_ar: "السعر", label_en: "Price", label: "Price" };
const area = { field: "area_value", label_ar: "المساحة", label_en: "Area", label: "Area" };

test("a typed but unreadable price is explained, an empty one is not", () => {
  expect(FormChecks.explainInvalid([price], { price_value: "abc" }, "en")[0].label).toBe("Price: not a valid amount");
  expect(FormChecks.explainInvalid([price], { price_value: "abc" }, "ar")[0].label).toBe("السعر: مش مبلغ صحيح");
  expect(FormChecks.explainInvalid([price], { price_value: "" }, "en")[0].label).toBe("Price");
  expect(FormChecks.explainInvalid([price], {}, "en")[0].label).toBe("Price");
});

test("numbers say not a valid number, and both language labels are kept", () => {
  const out = FormChecks.explainInvalid([area], { area_value: "-5" }, "en")[0];
  expect(out.label).toBe("Area: not a valid number");
  expect(out.label_ar).toBe("المساحة: مش رقم صحيح");
  expect(out.label_en).toBe("Area: not a valid number");
});

test("a typed owner phone that is not an Egyptian mobile says so; a missing one is just needed", () => {
  const bad = FormChecks.ownerBlockers({ details: { owner_phone: "123", owner_name: "X" } }, {}, "en", { isNew: true });
  expect(bad[0].label).toMatch(/not a valid Egyptian mobile/);
  const none = FormChecks.ownerBlockers({ details: { owner_name: "X" } }, {}, "en", { isNew: true });
  expect(none[0].label).toBe("Owner phone");
});
