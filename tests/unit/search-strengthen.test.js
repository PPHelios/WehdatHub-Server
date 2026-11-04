// tests/unit/search-strengthen.test.js — the parser cases from the live search log and the wrong-search review:
// close spellings, Persian letters, Lake View as a compound or a feature, budget words, bare currency amounts, codes.
"use strict";

process.env.SEARCH_AI_FIRST = "false";
const Q = require("../../domain/searchQuery");
const Search = require("../../services/search");

const parse = (t) => Q.fallbackParse(t);
const keys = (p) => p.filters.places.map((x) => x.key);

describe("close spellings of a known place", () => {
  test.each([
    ["شقة في مفيده ٣ نوم", "mivida"],
    ["عايز مفروش في ميفيده ٣ نوم", "mivida"],
    ["ميڤيدا 3 نوم", "mivida"],
    ["Mivda 3 bed", "mivida"],
    ["Madinty apartment", "madinaty"]
  ])("%s", (text, key) => {
    const p = parse(text);
    expect(keys(p)).toContain(key);
    expect(p.filters.place_terms).toEqual([]);
  });

  test("a close spelling is reported so the broker sees how it was read", () => {
    const p = parse("شقة في مفيده");
    expect(p.meta.guesses).toEqual([{ typed: "مفيده", as: "ميفيدا" }]);
  });

  test("Persian letters are folded to Arabic ones", () => {
    expect(keys(parse("شقة في ميڤيدا"))).toContain("mivida");
  });

  test("a name that is not close to anything stays an unknown word", () => {
    const p = parse("Villa in dusit 4 bedrooms");
    expect(p.filters.place_terms).toEqual(["dusit"]);
    expect(p.meta.leftover).toContain("dusit");
  });

  test("a short ordinary word is never turned into a place", () => {
    expect(keys(parse("شقة اوفر ٣٠٠ الف"))).toEqual([]);
  });

  test("unknown words are kept even when a place was found (the bot asks about them)", () => {
    const p = parse("Lake veiw dusit villa 4 bed");
    expect(keys(p)).toEqual(["lake_view"]);
    expect(p.filters.place_terms).toEqual(["dusit"]);
  });
});

describe("Lake View: a compound, and a feature only in four phrasings", () => {
  test.each(["Lake View villa", "villa in lake view compound"])("%s is the compound", (t) => {
    const p = parse(t);
    expect(keys(p)).toEqual(["lake_view"]);
    expect(p.filters.features).toEqual([]);
  });
  test.each(["villa with lake view", "villa overlooking lake", "فيلا فيو بحيره", "فيلا فيو علي بحيره", "فيلا فيو على البحيرة"])("%s is the feature", (t) => {
    const p = parse(t);
    expect(keys(p)).toEqual([]);
    expect(p.filters.features).toEqual(["view_lagoon"]);
  });
  test("the compound and the feature can be asked together", () => {
    const p = parse("apartment in mivida with lake view");
    expect(keys(p)).toEqual(["mivida"]);
    expect(p.filters.features).toEqual(["view_lagoon"]);
  });
  test("the feature also matches Lake View units in the query", () => {
    const { sql } = Search.buildSearchQuery("a", parse("villa with lake view"));
    expect(sql).toContain("compound_key = 'lake_view'");
  });
});

describe("budget, currency and installment words", () => {
  test.each([
    ["شقة بادجت 70000", { price_max: 70000 }],
    ["بدور على شقة 2 نوم البادجت 8500", { price_max: 8500 }],
    ["شقة 5000 دولار", { price_max: 5000, currency: "USD" }],
    ["شقة 8500 جنيه", { price_max: 8500 }],
    ["شقة بقسط 20 الف", { price_max: 20000 }],
    ["شقة قسط 20000", { max_installment: 20000, price_max: null }],
    ["شقة قسط شهري 20 الف", { max_installment: 20000, price_max: null }]
  ])("%s", (t, want) => {
    const f = parse(t).filters;
    for (const [k, v] of Object.entries(want)) expect(f[k]).toBe(v);
  });
  test("a budget with no installment word never becomes an installment", () => {
    expect(parse("azad 2 br budget 70k").filters.max_installment).toBeNull();
  });
  test("an amount with a currency and a limit word keeps working", () => {
    expect(parse("شقة 120 متر تحت 5000 دولار").filters).toMatchObject({ price_max: 5000, currency: "USD", area_min: 120 });
  });
});

describe("feature words and unit codes", () => {
  test("kitchen and the apostrophe form of ACs", () => {
    expect(parse("3 bedrooms Kitchen and ac's").filters.features.sort()).toEqual(["ac_installed", "kitchen_installed"]);
  });
  test("a plain swimming pool is a feature word, not a place", () => {
    const f = parse("فيلا حمام سباحة 4 غرف").filters;
    expect(f.feature_terms).toEqual(["حمام سباحه"]);
    expect(f.place_terms).toEqual([]);
  });
  test.each([["HP218", "HP218"], ["hp-218", "HP-218"], ["N4-105", "N4-105"]])("code %s is read locally", (t, code) => {
    const p = parse(t);
    expect(p.filters.code).toBe(code);
    expect(p.meta.unsure).toBe(false);
  });
  test("a word with a number inside a longer request is not a code", () => {
    expect(parse("villa2 in mivida").filters.code).toBeNull();
  });
});

describe("the two readings are compared", () => {
  test("filters that differ are named; equal readings give nothing", () => {
    const a = parse("شقة 3 غرف في ازاد");
    const b = parse("شقة 3 غرف في ازاد تحت 5 مليون");
    expect(Q.disagreements(a, a)).toEqual([]);
    expect(Q.disagreements(a, b)).toEqual(["price_max"]);
  });
  test("a place one reading could not find shows as place_terms and places", () => {
    const d = Q.disagreements(parse("شقة في دوسيت"), parse("شقة في ازاد"));
    expect(d).toEqual(expect.arrayContaining(["places", "place_terms"]));
  });
});
