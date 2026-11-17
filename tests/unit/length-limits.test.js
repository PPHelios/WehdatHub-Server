// tests/unit/length-limits.test.js — QA round 2 (item 48): a value longer than its field keeps is refused with the maximum,
// not cut silently. A lead's name is 60 characters at most.
"use strict";

const FormChecks = require("../../lib/formChecks");

test("a unit text over its limit is a blocker that names the maximum", () => {
  const out = FormChecks.lengthBlockers({ notes: "n".repeat(1001), address: "a".repeat(200), code: "c".repeat(31) }, "en");
  expect(out.map((b) => b.field).sort()).toEqual(["code", "notes"]);
  expect(out.find((b) => b.field === "notes").label).toBe("Notes: too long (1000 characters at most)");
  expect(FormChecks.lengthBlockers({ notes: "n".repeat(1001) }, "ar")[0].label).toMatch(/1000/);
});

test("texts at the limit, empty texts and missing fields are fine", () => {
  expect(FormChecks.lengthBlockers({ notes: "n".repeat(1000) }, "en")).toEqual([]);
  expect(FormChecks.lengthBlockers({}, "en")).toEqual([]);
  expect(FormChecks.lengthBlockers(undefined, "en")).toEqual([]);
});

test("explainInvalid also reports too-long texts", () => {
  const out = FormChecks.explainInvalid([], { notes: "n".repeat(1500) }, "en");
  expect(out).toHaveLength(1);
  expect(out[0].field).toBe("notes");
});
