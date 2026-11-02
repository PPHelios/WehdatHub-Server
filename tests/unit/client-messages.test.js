// The client-facing viewing message reads well with optional fields left out, and the ⓘ tips exist in both languages.
"use strict";

const Viewings = require("../../services/viewings");
const { templatesFor } = require("../../domain/clientMessageTemplates");

const at = new Date("2026-11-10T10:00:00Z");
const actor = { name: "Hany" };

test("a viewing message without a name or unit or place still greets politely and drops empty lines", () => {
  const text = Viewings.clientMessage({ lead: { name: null }, actor, listing: null, at, place: null, url: "https://x.test/v", lang: "ar" });
  expect(text.split("\n")[0]).toBe("أهلاً بحضرتك،");
  expect(text).not.toMatch(/🏠|📍/);
  expect(text).toContain("https://x.test/v");
  expect(text.split("\n").at(-1)).toBe("— Hany");
});

test("a viewing message with a name keeps the first name and the place", () => {
  const text = Viewings.clientMessage({ lead: { name: "Sara Ali" }, actor: { name: "" }, listing: null, at, place: "Gate 3", url: "https://x.test/v", lang: "ar" });
  expect(text.split("\n")[0]).toBe("أهلاً Sara،");
  expect(text).toContain("📍 Gate 3");
});

test("the English viewing message greets without a name", () => {
  const text = Viewings.clientMessage({ lead: { name: null }, actor: { name: "" }, listing: null, at, place: null, url: "https://x.test/v", lang: "en" });
  expect(text.split("\n")[0]).toBe("Hello,");
});

test("each send has a tip in both languages", () => {
  for (const lang of ["ar", "en"]) {
    const t = templatesFor(lang);
    expect(t.viewing).toMatch(/\{/);
    expect(t.draft).toMatch(/\{|\(/);
    expect(t.unit).toMatch(/\{/);
  }
});
