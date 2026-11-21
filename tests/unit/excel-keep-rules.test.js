// tests/unit/excel-keep-rules.test.js — a re-import keeps the app's notes and sold status, and a compound alias is not a change.
"use strict";

const Imports = require("../../services/imports");

describe("keepAppText", () => {
  test("keeps the unit's notes and description when the sheet has other text", () => {
    const existing = { status: "active", details: { notes: "app note", clean_summary: "app text" } };
    const patch = { details: { notes: "sheet note", clean_summary: "sheet text", owner_name: "Ali" } };
    const kept = Imports.keepAppText(existing, patch);
    expect(patch.details).toEqual({ notes: "app note", clean_summary: "app text", owner_name: "Ali" });
    expect(kept).toBeNull();
  });

  test("a sold or archived unit keeps its status and says so", () => {
    const patch = { status: "archived" };
    expect(Imports.keepAppText({ status: "sold", details: {} }, patch)).toBe("sold");
    expect(patch).not.toHaveProperty("status");
  });

  test("an active unit takes the sheet's status", () => {
    const patch = { status: "sold" };
    expect(Imports.keepAppText({ status: "active", details: {} }, patch)).toBeNull();
    expect(patch.status).toBe("sold");
  });
});

describe("sameCompoundAs", () => {
  const existing = { compound: "فيفث سكوير", place_id: 7 };

  test("same place id is the same compound", () => {
    expect(Imports.sameCompoundAs({ place_id: 7, compound: "5th Square" }, existing)).toBe(true);
  });

  test("same name under another spelling is the same compound", () => {
    expect(Imports.sameCompoundAs({ place_id: null, compound: "فيفث سكوير" }, existing)).toBe(true);
  });

  test("a different place is not the same compound", () => {
    expect(Imports.sameCompoundAs({ place_id: 9, compound: "Mivida" }, existing)).toBe(false);
  });

  test("an unresolved name never matches a unit with no place", () => {
    expect(Imports.sameCompoundAs({ place_id: null, compound: null }, { compound: "X", place_id: null })).toBe(false);
    expect(Imports.sameCompoundAs(null, existing)).toBe(false);
  });
});
