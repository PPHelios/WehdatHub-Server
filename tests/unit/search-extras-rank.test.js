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

describe("places and words from the logged searches that the quick reader missed", () => {
  const read = (text) => Q.fallbackParse(text);
  const places = (text) => read(text).filters.places.map((p) => p.key);

  test("the start of a compound name is read as that compound and shown as a guess", () => {
    for (const text of ["شقة 3 غرف في هايد", "apartment in hyde", "Apartment in hyde pay"]) {
      const r = read(text);
      expect(places(text)).toEqual(["hyde_park"]);
      expect(r.filters.place_terms).toEqual([]);
      expect(r.meta.guesses.length).toBe(1);
    }
  });
  test("a country, city or governorate word is never the start of a compound", () => {
    expect(places("apartment in cairo")).toEqual([]);
    expect(read("apartment in cairo").filters.place_terms).toEqual(["cairo"]);
  });
  test("an unknown spelling is a guess the person can accept or fix", () => {
    const r = read("شقة في فيلدا");
    expect(r.meta.guesses).toEqual([expect.objectContaining({ typed: "فيلدا", as: "فيلدج" })]);
    expect(r.filters.places.map((p) => p.key)).toEqual(["the_village"]);
  });
  test("the kitchen with ال, 'full furnished' and 'ned' leave nothing behind", () => {
    expect(read("شقة 3 نوم في هايد بارك، المطبخ تكييفات").filters.place_terms).toEqual([]);
    expect(read("شقة 3 نوم في هايد بارك، المطبخ تكييفات").filters.furnishing).toBe("kitchen_and_ac");
    const a = read("Studio for rent in mivida full furnished").filters;
    expect(a.place_terms).toEqual([]);
    expect(a.furnishing).toBe("furnished");
    expect(read("Ned apartment for rent in mivida Fully furnished").filters.place_terms).toEqual([]);
  });
  test("a guessed spelling is not counted as a parser-vs-AI disagreement on places", () => {
    const local = read("استوديو للايجار في فيلدا");
    const ai = { filters: { ...local.filters, places: [{ kind: "compound", key: "villette" }] } };
    expect(Q.disagreements(local, ai)).not.toContain("places");
    expect(Q.disagreements({ filters: local.filters }, ai)).toContain("places"); // with no guess it still counts
  });
});

describe("more words the quick reader understands", () => {
  const x = (text) => Q.fallbackParse(text);

  test.each([
    ["الأرخص شقة في التجمع", "price_asc"],
    ["cheapest apartment in new cairo", "price_asc"],
    ["الأغلى شقة", "price_desc"],
    ["شقة الأحدث", "newest"],
    ["newest apartment", "newest"],
    ["شقة أكبر مساحة", "area_desc"],
    ["شقة أصغر مساحة", "area_asc"]
  ])("order: %s", (text, sort) => {
    const r = x(text);
    expect(r.filters.sort).toBe(sort);
    expect(r.filters.place_terms).toEqual([]);
  });

  test("an order alone is not a search", () => {
    expect(Q.fallbackParse("الأرخص").intent).toBe("other");
  });

  test.each([
    ["شقة حوالي 150 متر", 135, 165],
    ["apartment about 200 sqm", 180, 220],
    ["شقة 150 متر", 150, null]
  ])("area: %s", (text, min, max) => {
    const f = x(text).filters;
    expect([f.area_min, f.area_max]).toEqual([min, max]);
    expect(f.place_terms).toEqual([]);
  });

  test.each([
    ["شقة مش ارضي", 1, null],
    ["apartment not ground floor", 1, null],
    ["شقة دور عالي", 4, null],
    ["apartment high floor", 4, null],
    ["شقة دور أرضي", 0, 0],
    ["شقة دور 3", 3, 3]
  ])("floor: %s", (text, min, max) => {
    const f = x(text).filters;
    expect([f.floor_min, f.floor_max]).toEqual([min, max]);
    expect(f.place_terms).toEqual([]);
  });

  test("ready, in the spelling people use", () => {
    expect(x("شقة جاهزة").filters.delivery_ready).toBe(true);
  });

  test("near a landmark stays a place word: it is looked up in the unit text (an earlier decision)", () => {
    expect(x("شقة جنب النادي").filters.place_terms).toEqual(["النادي"]);
    expect(x("apartment near new cairo").filters.places.map((p) => p.key)).toEqual(["new_cairo"]);
  });

  test("an AI answer may carry the order, and anything else is dropped", () => {
    expect(Q.normalizeAiSearch({ intent: "search", filters: { sort: "newest", property_types: ["apartment"] } }).filters.sort).toBe("newest");
    expect(Q.normalizeAiSearch({ intent: "search", filters: { sort: "drop table", property_types: ["apartment"] } }).filters.sort).toBeNull();
  });
});

describe("the asked order is used when the units are listed", () => {
  let h;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(closeHarness);

  const order = async (sort) => {
    const res = await Search.runSearch(h.pool, h.AGENCY_A, { filters: { ...Q.emptyFilters(), property_types: ["apartment"], sort } });
    const codes = (await h.query("SELECT id, code FROM listings WHERE id = ANY($1::uuid[])", [res.ids])).reduce((m, r) => ({ ...m, [r.id]: r.code }), {});
    return res.ids.map((id) => codes[id]);
  };

  test("cheapest, most expensive, largest and smallest first", async () => {
    await h.query("DELETE FROM listings WHERE agency_id = $1", [h.AGENCY_A]);
    await h.insertListing({ code: "MID", property_type: "apartment", price_value: 5e6, area_value: 150 });
    await h.insertListing({ code: "LOW", property_type: "apartment", price_value: 3e6, area_value: 90 });
    await h.insertListing({ code: "HIGH", property_type: "apartment", price_value: 9e6, area_value: 220 });
    expect(await order("price_asc")).toEqual(["LOW", "MID", "HIGH"]);
    expect(await order("price_desc")).toEqual(["HIGH", "MID", "LOW"]);
    expect(await order("area_desc")).toEqual(["HIGH", "MID", "LOW"]);
    expect(await order("area_asc")).toEqual(["LOW", "MID", "HIGH"]);
  });
});
