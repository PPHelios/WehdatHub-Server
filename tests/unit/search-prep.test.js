// tests/unit/search-prep.test.js — Phase 2: Franco, colloquial money, floor, finishing and area phrases reach the search parser
// through the shared readers (domain/read/searchPrep.js). Texts with none of these phrases are not touched.
"use strict";

const Q = require("../../domain/searchQuery");
const { prepareSearchText } = require("../../domain/read/searchPrep");

const f = (q) => Q.fallbackParse(q).filters;

describe("search prep leaves ordinary text alone", () => {
  test.each(["شقة 3 غرف في التجمع تحت 9 مليون", "apartment in mivida 3 bedrooms", "villa 4 bedrooms 300 sqm under 30m", "", "   "])("%s", (t) =>
    expect(prepareSearchText(t)).toBe(t),
  );
});

describe("Phase 2 phrases", () => {
  test("Franco: 3 ghorf fel tagamo3", () => {
    const r = f("3 ghorf fel tagamo3");
    expect(r.bedrooms_min).toBe(3);
    expect(r.places).toEqual([{ kind: "area", key: "new_cairo" }]);
  });
  test("Franco: sha2a fel re7ab lel egar", () => {
    const r = f("sha2a fel re7ab lel egar");
    expect(r.listing_type).toBe("rent");
    expect(r.property_types).toEqual(["apartment"]);
    expect(r.places).toEqual([{ kind: "compound", key: "rehab" }]);
  });
  test("Franco nanny room stays a feature", () => expect(f("villa ghorfa morabeya").features.length).toBeGreaterThan(0));
  test("شقة ارضي is a ground-floor apartment, never land", () => {
    const r = f("شقة ارضي في التجمع");
    expect(r.property_types).toEqual(["apartment"]);
    expect([r.floor_min, r.floor_max]).toEqual([0, 0]);
  });
  test("سيمي فينشد", () => expect(f("شقة سيمي فينشد 3 غرف").finishing).toEqual(["semi_finished"]));
  test("كور اند شيل", () => expect(f("شقة كور اند شيل").finishing).toEqual(["core_and_shell"]));
  test("تاني دور", () => {
    const r = f("شقة تاني دور");
    expect([r.floor_min, r.floor_max]).toEqual([2, 2]);
  });
  test("غرفة وصالة is one bedroom", () => expect(f("شقة غرفة وصالة").bedrooms_min).toBe(1));
  test("مساحة 150", () => expect(f("شقة مساحة 150").area_min).toBe(150));
  test("land and BUA: the built-up area is used", () => {
    const r = f("فيلا في الشيخ زايد 450 sqm land 380 BUA");
    expect(r.area_min).toBe(380);
    expect(r.property_types).toEqual(["villa"]);
  });
  test.each([
    ["شقة ٣ ونص مليون", 3500000],
    ["شقة 5 مليون الا ربع", 4750000],
    ["شقة 2 غرف 7 مليون و 200", 7200000],
    ["شقة 3 مليون ونص التجمع", 3500000],
  ])("ceiling %s", (q, v) => expect(f(q).price_max).toBe(v));

  test("multi-part: room, place, ceiling and negated furnishing each read on their own", () => {
    const r = f("شقة 3 غرف في التجمع بحد أقصى 5 مليون مش مفروشة");
    expect(r).toMatchObject({ property_types: ["apartment"], bedrooms_min: 3, price_max: 5000000, furnishing: "unfurnished" });
    expect(r.places).toEqual([{ kind: "area", key: "new_cairo" }]);
  });
  test("a place name is not read as a property type (Rule A)", () => {
    expect(f("سيليا للايجار").property_types).toEqual([]);
    expect(f("تسعين أفينيو للايجار").property_types).toEqual([]);
  });
});
