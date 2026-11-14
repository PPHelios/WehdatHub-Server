"use strict";

// The Ask test data parses: every test project has offers in its notes, and the sizes-missing one stays without a size.
const { TEST_PROJECTS, LOGIN_ROLES } = require("../../scripts/seed-ask");
const PN = require("../../domain/projectNotes");

test("every test project has offers, and one has no sizes written", () => {
  for (const p of TEST_PROJECTS) expect(PN.parseUnits(p.notes).length).toBeGreaterThan(0);
  const bare = TEST_PROJECTS.find((p) => p.name_en === "Capital Tower");
  expect(PN.parseUnits(bare.notes).every((u) => u.area == null)).toBe(true);
});

test("one sign-in per role, each with a distinct phone", () => {
  const phones = Object.values(LOGIN_ROLES).map((r) => r.phone);
  expect(new Set(phones).size).toBe(phones.length);
  expect(Object.values(LOGIN_ROLES).map((r) => r.role)).toEqual(expect.arrayContaining(["manager", "owner", "broker", "agent"]));
});
