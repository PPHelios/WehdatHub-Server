// tests/unit/design-tokens.test.js — every text colour is readable on its surface, in light and in dark (domain/designTokens.js)
"use strict";

const T = require("../../domain/designTokens");

test("no colour pair is below its contrast level in either mode", () => {
  expect(T.unreadable()).toEqual([]);
});

test("light and dark carry the same names; azure leads in light and copper in dark", () => {
  expect(Object.keys(T.COLORS.dark).sort()).toEqual(Object.keys(T.COLORS.light).sort());
  expect(T.COLORS.light.brand).toBe("#1d70b8");
  expect(T.COLORS.dark.accent).toBe("#4e9fea");
  expect(T.cssVars()).toMatch(/:root\[data-theme="dark"\] \{[^}]*--brand: #e8845a;/);
});
