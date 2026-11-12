// tests/unit/furnishing-status.test.js — "kitchen and AC" is a furnishing status: its units first, then units whose status is blank.
"use strict";

process.env.SEARCH_AI_FIRST = "false";
const Q = require("../../domain/searchQuery");
const Search = require("../../services/search");

describe("kitchen and AC is a furnishing status", () => {
  test.each(["kitchen and ac", "kitchen and AC", "ac and kitchen", "شقة مطبخ وتكييف", "مطبخ و تكييف"])("%s → status kitchen_and_ac, no feature filters", (t) => {
    const f = Q.fallbackParse(t).filters;
    expect(f.furnishing).toBe("kitchen_and_ac");
    expect(f.features).toEqual([]);
  });
  test("with furnished said, the two features stay as features", () => {
    const f = Q.fallbackParse("fully furnished with kitchen and ac").filters;
    expect(f.furnishing).toBe("furnished");
    expect(f.features).toEqual(expect.arrayContaining(["ac_installed", "kitchen_installed"]));
  });
  test("the AI cannot add a status outside the list", () => {
    const f = Q.normalizeAiSearch({ intent: "search", filters: { furnishing: "garden view" } }).filters;
    expect(f.furnishing).toBeNull();
  });
  test("the search puts the exact status first, then blank status", () => {
    const { sql } = Search.buildSearchQuery("a", Q.fallbackParse("kitchen and ac"));
    expect(sql).toMatch(/CASE WHEN l\.furnishing = \$\d+ OR \(l\.furnishing IS NULL AND l\.feature_keys @> \$\d+::text\[\]\) THEN 0 WHEN l\.furnishing = ANY/);
    expect(sql).toMatch(/l\.furnishing IS NULL OR l\.furnishing = ANY/);
  });
});

const { mapFurnishing, mapFinishing } = require("../../domain/furnishingStatus");

describe("free-text furnishing maps to one fixed status", () => {
  test.each([
    ["مفروشه", "furnished"], ["مفروش", "furnished"], ["فرش كامل", "furnished"], ["fully furnished", "furnished"], ["furnished", "furnished"],
    ["نص مفروشه", "semi_furnished"], ["نصف مفروش", "semi_furnished"], ["نص مفروش", "semi_furnished"], ["semi furnished", "semi_furnished"],
    ["فاضيه", "unfurnished"], ["فاضي", "unfurnished"], ["بدون فرش", "unfurnished"], ["غير مفروشه", "unfurnished"], ["unfurnished", "unfurnished"],
    ["مطبخ وتكييف", "kitchen_and_ac"], ["مطبخ و تكييفات", "kitchen_and_ac"], ["kitchen and ac", "kitchen_and_ac"],
    ["تكييفات", "ac_only"], ["تكييف", "ac_only"], ["تكيفات بس", "ac_only"],
    ["مطبخ", "kitchen_only"], ["مطبخ بس", "kitchen_only"]
  ])("%s → %s", (text, expected) => {
    expect(mapFurnishing(text)).toBe(expected);
  });
  test("a furnished unit with kitchen and AC is furnished", () => {
    expect(mapFurnishing("مفروشة مع مطبخ وتكييف")).toBe("furnished");
  });
  test("text that says nothing about furnishing maps to null", () => {
    expect(mapFurnishing("كوشه")).toBeNull();
    expect(mapFurnishing("")).toBeNull();
  });
});

describe("free-text finishing maps to one fixed status", () => {
  test.each([
    ["محارة", "core_and_shell"], ["على الطوب", "core_and_shell"], ["بدون تشطيب", "core_and_shell"], ["core and shell", "core_and_shell"],
    ["نص تشطيب", "semi_finished"], ["نصف تشطيب", "semi_finished"], ["semi finished", "semi_finished"],
    ["تشطيب كامل", "fully_finished"], ["متشطب", "fully_finished"], ["fully finished", "fully_finished"],
    ["سوبر لوكس", "super_lux"], ["super lux", "super_lux"],
    ["الترا سوبر لوكس", "ultra_super_lux"], ["ultra super lux", "ultra_super_lux"]
  ])("%s → %s", (text, expected) => {
    expect(mapFinishing(text)).toBe(expected);
  });
});

describe("AC only and kitchen only are searchable statuses", () => {
  test("AC only sets ac_only and drops the AC feature", () => {
    const f = Q.fallbackParse("شقة تكييف بس").filters;
    expect(f.furnishing).toBe("ac_only");
    expect(f.features).not.toContain("ac_installed");
  });
  test("kitchen only sets kitchen_only", () => {
    const f = Q.fallbackParse("kitchen only apartment").filters;
    expect(f.furnishing).toBe("kitchen_only");
    expect(f.features).not.toContain("kitchen_installed");
  });
  test("plain AC or plain kitchen ('with AC') reads as the AC-only / kitchen-only status, which lists kitchen and AC next (Haytham 2026-11-12)", () => {
    expect(Q.fallbackParse("apartment with ac").filters).toMatchObject({ furnishing: "ac_only", features: [] });
    expect(Q.fallbackParse("apartment with kitchen").filters).toMatchObject({ furnishing: "kitchen_only", features: [] });
    expect(Q.normalizeAiSearch({ filters: { features: ["ac_installed"] } }).filters.furnishing).toBe("ac_only");
  });
  test("the AI's finishing and furnishing values are mapped to the fixed set", () => {
    const f = Q.normalizeAiSearch({ intent: "search", filters: { furnishing: "semi furnished", finishing: ["نص تشطيب"] } }).filters;
    expect(f.furnishing).toBe("semi_furnished");
    expect(f.finishing).toEqual(["semi_finished"]);
  });
});
