// tests/unit/design-tokens.test.js — every text colour is readable on its surface, in light and in dark (domain/designTokens.js)
"use strict";

const T = require("../../domain/designTokens");

test("no colour pair is below its contrast level in either mode", () => {
  expect(T.unreadable()).toEqual([]);
});

test("light and dark carry the same names; brushed satin gold leads with royal blue companion", () => {
  expect(Object.keys(T.COLORS.dark).sort()).toEqual(Object.keys(T.COLORS.light).sort());
  expect(T.COLORS.light.brand).toBe("#c29741");
  expect(T.COLORS.light.accent).toBe("#122b4f");
  expect(T.COLORS.dark.accent).toBe("#4b83d4");
  expect(T.cssVars()).toMatch(/:root\[data-theme="dark"\] \{[^}]*--brand: #d5af55;/);
});
