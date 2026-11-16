// tests/unit/search-extras-rank.test.js — Phase 8: extras rank, they never hide (Haytham, 2026-11-12), and the phrases from
// the daily search check (a zero-result search and a parser/AI difference) now read correctly. Ranges written with a hyphen,
// "in" glued to a place, and a place name that looks like a property word are read, not turned into place words.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const Q = require("../../domain/searchQuery");
const Search = require("../../services/search");
const { FEATURES } = require("../../domain/features");

jest.setTimeout(120000);

const f = (text) => Q.fallbackParse(text).filters;

describe("the phrases from the search check", () => {
  test("kitchen with appliances and ACs, a budget of 50-55k, in التجمع (written فالتجمع), any compound", () => {
    const x = f("محتاجه ضروري في اي كومبوند فالتجمع شقة ٢ نوم مطبخ بالأجهزه وتكييفات بادجيت 50-55k");
    expect(x.price_min).toBe(50000);
    expect(x.price_max).toBe(55000);
    expect(x.places).toEqual([{ kind: "area", key: "new_cairo" }]);
    expect(x.property_types).toEqual(["apartment"]);
    expect(x.bedrooms_min).toBe(2);
    expect(x.features).toContain("appliances");
    expect(x.place_terms).toEqual([]); // nothing left over to hide the answer
  });

  test("a studio for rent in فيلدا, furnished: فيلدا is a place word, not a villa", () => {
    for (const text of ["استوديول للإيجار في فيلدا مفروش", "استوديو للايجار في فيلدا مفروش"]) {
      const x = f(text);
      expect(x.property_types).toEqual(["studio"]);
      expect(x.listing_type).toBe("rent");
      expect(x.furnishing).toBe("furnished");
    }
  });

  test("a real typo of a property word still reads as that type", () => {
    expect(f("vilal في التجمع").property_types).toEqual(["villa"]);
  });
});

describe("ranges written with a hyphen", () => {
  test.each([
    ["شقة 50-55k", { price_min: 50000, price_max: 55000 }],
    ["شقة 50k-55k", { price_min: 50000, price_max: 55000 }],
    ["شقة ٥٠-٥٥k", { price_min: 50000, price_max: 55000 }],
    ["شقة 2-3 غرف", { bedrooms_min: 2, bedrooms_max: 3 }],
    ["شقة من 2 الى 3 غرف", { bedrooms_min: 2, bedrooms_max: 3 }],
    ["apartment 2-3 bedrooms", { bedrooms_min: 2, bedrooms_max: 3 }],
    ["شقة 40-60 متر", { area_min: 40, area_max: 60 }],
    ["apartment 100-150 sqm", { area_min: 100, area_max: 150 }]
  ])("%s", (text, want) => {
    const x = f(text);
    for (const [k, v] of Object.entries(want)) expect([k, x[k]]).toEqual([k, v]);
    expect(x.place_terms).toEqual([]);
  });

  test("a plain count is still a minimum", () => {
    const x = f("شقة 3 غرف");
    expect([x.bedrooms_min, x.bedrooms_max]).toEqual([3, null]);
  });
});

describe("extras rank and never hide", () => {
  let h;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(closeHarness);

  const SOFT = FEATURES.filter((x) => x.group === "equipment" || x.group === "outdoor").map((x) => x.key);

  test.each(SOFT)("asking for %s keeps a unit that has other extras but not this one, and lists the unit that has it first", async (key) => {
    await h.query("DELETE FROM listings WHERE agency_id = $1", [h.AGENCY_A]);
    const other = SOFT.find((k) => k !== key);
    await h.insertListing({ code: "NONE-1", property_type: "apartment", price_value: 5e6, feature_keys: [] });
    await h.insertListing({ code: "OTHER-1", property_type: "apartment", price_value: 5e6, feature_keys: [other] });
    await h.insertListing({ code: "HAS-1", property_type: "apartment", price_value: 5e6, feature_keys: [key] });
    const parsed = { filters: { ...Q.emptyFilters(), property_types: ["apartment"], features: [key] } };
    const res = await Search.runSearch(h.pool, h.AGENCY_A, parsed);
    const codes = (await h.query("SELECT id, code FROM listings WHERE id = ANY($1::uuid[])", [res.ids])).reduce((m, r) => ({ ...m, [r.id]: r.code }), {});
    const ordered = res.ids.map((id) => codes[id]);
    expect(ordered).toHaveLength(3); // nothing was hidden
    expect(ordered[0]).toBe("HAS-1"); // the unit that has the extra comes first
  });

  test("two asked extras: the unit with both is first, then the one with one, then the rest", async () => {
    await h.query("DELETE FROM listings WHERE agency_id = $1", [h.AGENCY_A]);
    await h.insertListing({ code: "ZERO", property_type: "apartment", price_value: 5e6, feature_keys: [] });
    await h.insertListing({ code: "ONE", property_type: "apartment", price_value: 5e6, feature_keys: ["appliances"] });
    await h.insertListing({ code: "BOTH", property_type: "apartment", price_value: 5e6, feature_keys: ["appliances", "ac_installed"] });
    const parsed = { filters: { ...Q.emptyFilters(), property_types: ["apartment"], features: ["appliances", "ac_installed"] } };
    const res = await Search.runSearch(h.pool, h.AGENCY_A, parsed);
    const codes = (await h.query("SELECT id, code FROM listings WHERE id = ANY($1::uuid[])", [res.ids])).reduce((m, r) => ({ ...m, [r.id]: r.code }), {});
    expect(res.ids.map((id) => codes[id])).toEqual(["BOTH", "ONE", "ZERO"]);
  });

  test("a building fact (not an extra) still filters", async () => {
    await h.query("DELETE FROM listings WHERE agency_id = $1", [h.AGENCY_A]);
    await h.insertListing({ code: "N-1", property_type: "apartment", price_value: 5e6, feature_keys: ["north_facing"] });
    await h.insertListing({ code: "S-1", property_type: "apartment", price_value: 5e6, feature_keys: ["corner"] });
    const parsed = { filters: { ...Q.emptyFilters(), property_types: ["apartment"], features: ["north_facing"] } };
    const res = await Search.runSearch(h.pool, h.AGENCY_A, parsed);
    expect(res.ids).toHaveLength(1);
  });
});
