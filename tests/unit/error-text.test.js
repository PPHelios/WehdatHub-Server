// tests/unit/error-text.test.js — QA round 2 (item 50, phase 1): one table of error sentences, in both languages, and the API
// adds `message` to its error answers so the app never shows a raw code.
"use strict";

const ErrorText = require("../../lib/errorText");

test("every code has an Arabic and an English sentence, and none is the code itself", () => {
  for (const code of ErrorText.CODES) {
    const ar = ErrorText.of(code, "ar");
    const en = ErrorText.of(code, "en");
    expect([code, !!ar, !!en]).toEqual([code, true, true]);
    expect(en).not.toBe(code);
    expect(ar).not.toBe(code);
  }
});

test("the codes seen in QA read as sentences", () => {
  expect(ErrorText.of("follow_up_past", "en")).toBe("That time has passed; choose a future one.");
  expect(ErrorText.of("owner_name_required", "en")).toMatch(/owner/i);
  expect(ErrorText.of("commission_over_price", "ar")).toMatch(/العمولة/);
  expect(ErrorText.of("read_only_view", "en")).toMatch(/Read only/);
});

test("an unknown code gets a generic line, never the raw code", () => {
  expect(ErrorText.of("no_such_code")).toBe(null);
  expect(ErrorText.ofOrGeneric("no_such_code", "en")).toBe("Something went wrong. Try again.");
  expect(ErrorText.ofOrGeneric("no_such_code", "en")).not.toMatch(/no_such_code/);
});
