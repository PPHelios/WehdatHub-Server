// tests/unit/import-code-prefix-escape.test.js — A code prefix read from an import sheet is escaped before it is used in a pattern or a LIKE
// query (audit 2026-11-06: a crafted prefix must not slow the server or break the import).
"use strict";

const { escapeRegex, escapeLike } = require("../../services/imports");

test("a pattern-looking prefix matches only itself", () => {
  const prefix = "(a+)+$";
  const re = new RegExp("^" + escapeRegex(prefix) + "[-_ ]?(\\d+)$", "i");
  expect(re.test("(a+)+$-12")).toBe(true);
  expect(re.test("aaaaaaaaaaaaaaaaaaaaaaaaaaaa!")).toBe(false);
});

test("an unbalanced bracket prefix does not throw", () => {
  expect(() => new RegExp("^" + escapeRegex("A[") + "(\\d+)$", "i")).not.toThrow();
});

test("LIKE wildcards in a prefix are taken literally", () => {
  expect(escapeLike("A%_B\\")).toBe("A\\%\\_B\\\\");
});
