// tests/unit/solo-copy.test.js — Notices for a one-person account talk about the account, not a "company" or its manager.
"use strict";

const { t } = require("../../lib/copy");

test("the Arabic notices say الشركة, and a solo account says حسابك instead", () => {
  const team = t("credits_hint_50", "ar", { url: "u" });
  expect(team).toContain("الشركة");
  expect(team).not.toContain("الوكالة");
  const solo = t("credits_hint_50", "ar", { url: "u", solo: true });
  expect(solo).not.toContain("الشركة");
  expect(solo).toContain("حسابك");
  expect(t("web_login_ceiling", "ar", { solo: true })).toContain("كلم الدعم");
  expect(t("credits_hint_80", "en", { url: "u", solo: true })).toContain("You have");
});
