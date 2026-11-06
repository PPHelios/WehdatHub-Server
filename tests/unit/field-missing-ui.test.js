// tests/unit/field-missing-ui.test.js — Mandatory fields show a red outline when a step is blocked, and the outline clears on change
// (Haytham 2026-11-06). The bedrooms label carries the mandatory star.
"use strict";

const fs = require("fs");
const path = require("path");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", "..", f), "utf8");

test("bedrooms is marked mandatory with a star", () => {
  expect(read("web/views/unitForm.js")).toMatch(/"الغرف \*", "Bedrooms \*"/);
});

test("a blocked step outlines its fields in red and the outline clears on change", () => {
  const js = read("web/static/app.js");
  expect(js).toMatch(/classList\.add\("field-missing"\)/);
  expect(js).toMatch(/classList\.remove\("field-missing"\)/);
  expect(read("web/static/app.css")).toMatch(/label\.field-missing[^{]*\{[^}]*var\(--bad\)/);
});
