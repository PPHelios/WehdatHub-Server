// tests/unit/unit-types.test.js — The new unit types (triplex, triplex with roof, sky loft, basement, mazonette) are
// recognised in Arabic and English, with their field group and unit-code letter; "ground with garden" is an apartment
// with a private garden; the import review does not flag them as unrecognized.
"use strict";

const SheetImport = require("../../domain/sheetImport");
const Mixed = require("../../domain/sheetMixed");
const Rules = require("../../domain/fieldRules");
const UnitCode = require("../../domain/unitCode");
const Describe = require("../../domain/describe");
const { TYPE_TERMS } = require("../../domain/vocabulary");
const Gallery = require("../../domain/gallery");

const NEW_TYPES = ["triplex", "triplex_roof", "sky_loft", "basement", "mazonette"];

describe("recognition by name", () => {
  test.each([
    ["تريبلكس", "triplex"],
    ["triplex", "triplex"],
    ["Triplex", "triplex"],
    ["تريبلكس روف", "triplex_roof"],
    ["triplex roof", "triplex_roof"],
    ["triplex with roof", "triplex_roof"],
    ["سكاي لوفت", "sky_loft"],
    ["sky loft", "sky_loft"],
    ["basement", "basement"],
    ["بدروم", "basement"],
    ["mazonette", "mazonette"],
    ["مازونيت", "mazonette"],
    ["ground with garden", "apartment"],
    ["Ground Floor with Garden", "apartment"],
  ])("%s is %s", (text, key) => {
    expect(SheetImport.propertyType(text)).toBe(key);
  });

  test("a typo of a new type is still that type", () => {
    expect(SheetImport.propertyType("triplx")).toBe("triplex");
    expect(SheetImport.propertyType("basment")).toBe("basement");
    expect(SheetImport.propertyType("mazonete")).toBe("mazonette");
  });

  test("the existing types are unchanged", () => {
    expect(SheetImport.propertyType("apartment")).toBe("apartment");
    expect(SheetImport.propertyType("شقة")).toBe("apartment");
    expect(SheetImport.propertyType("duplex")).toBe("duplex");
    expect(SheetImport.propertyType("something else entirely")).toBeNull();
  });

  test("every new type is a term in the search vocabulary, so a search finds it", () => {
    for (const key of NEW_TYPES) expect(TYPE_TERMS[key]).toBeDefined();
  });
});

describe("the sheet's own wording (from the rejected-rows file)", () => {
  test.each([
    ["i villa garden A middle", "i_villa"],
    ["I-Villa Garden", "i_villa"],
    ["twin villa 2-D", "twin_villa"],
    ["maisonette", "maisonette"],
    ["apartment 4th floor", "apartment"],
    ["apartment ground floor with garden", "apartment"],
    ["town house corner", "townhouse"],
    ["penthouse without roof", "penthouse"],
    ["studio with roof", "studio"],
    ["apaerment(cleo)", "apartment"],
    ["apatrment with garden", "apartment"],
    ["douplex with garden", "duplex"],
    ["twin houes", "twinhouse"],
  ])("%s is %s", (text, key) => {
    expect(SheetImport.propertyType(text)).toBe(key);
  });

  test("roof and corner words from the type cell go to the description", () => {
    const out = SheetImport.rowToDraft({ code: "TX-3", price_value: "3500000", area_value: "140", property_type: "town house corner" });
    expect(out.draft.property_type).toBe("townhouse");
    expect(out.draft.details.clean_summary).toContain("town house corner");
    const roof = SheetImport.rowToDraft({ code: "TX-4", price_value: "3500000", area_value: "140", property_type: "studio with roof" });
    expect(roof.draft.details.clean_summary).toContain("studio with roof");
  });

  test("a suffix word keeps the unit's garden feature", () => {
    const out = SheetImport.rowToDraft({ code: "TX-2", price_value: "3500000", area_value: "140", property_type: "apartment with garden" });
    expect(out.draft.feature_keys).toContain("private_garden");
  });

  test("a cell with several prices takes the long-term or monthly one", () => {
    expect(Mixed.cellPrice("long 90k / short 100k / day 6k")).toEqual({ value: 90000, usd: false });
    expect(Mixed.cellPrice("110k year/ 150k month / 7500day")).toEqual({ value: 150000, usd: false });
    expect(Mixed.cellPrice("DAY 5,290 / WEEK 4,761 / month 92,000/")).toEqual({ value: 92000, usd: false });
    expect(Mixed.cellPrice("120k monthly / every 3 months 105k long term 95k").usd).toBe(false);
  });

  test("with no long-term or monthly price, the first price is taken", () => {
    expect(Mixed.cellPrice("85k / 80k depending on terms")).toEqual({ value: 85000, usd: false });
  });

  test("a dollar price stays in dollars; a dollar cell with an EGP long-term price takes the EGP", () => {
    expect(Mixed.cellPrice("1000$")).toEqual({ value: 1000, usd: true });
    expect(Mixed.cellPrice("2000$ / 60K")).toEqual({ value: 2000, usd: true });
    expect(Mixed.cellPrice("long 80k/1600$")).toEqual({ value: 80000, usd: false });
  });

  test("an installment plan in the price cell: total, down payment and installments; the text goes to the description", () => {
    const text = "total 3,000,000 / down payment 2,485,000 / installments 515,000 till Feb 2026";
    expect(Mixed.installmentOf(text)).toEqual({ price_value: 3000000, down_payment_value: 2485000, remaining_amount: 515000 });
    const out = SheetImport.rowToDraft({ code: "TX-5", property_type: "apartment", price_value: text, area_value: "150" });
    expect(out.draft.market).toBe("resale");
    expect(out.draft.price_value).toBe(3000000);
    expect(out.draft.down_payment_value).toBe(2485000);
    expect(out.draft.remaining_amount).toBe(515000);
    expect(out.draft.details.clean_summary).toContain("till Feb 2026");
    expect(out.errors).not.toContain("price_value");
  });

  test("an installment plan with a total or down payment that cannot be read is held", () => {
    expect(Mixed.installmentOf("total 7,200,00M / Dp 6,780,700 M  installments 219,300 till 2024")).toBeNull();
    expect(Mixed.installmentOf("toral price 8,100,000 /downpayment 6 M / installments 2,100,000 till April 2024")).toBeNull();
  });

  test("text with no price is left as it is, so the row is reported", () => {
    expect(Mixed.cellPrice("wait price").value).toBe("wait price");
    expect(Mixed.cellPrice("wait price").usd).toBe(false);
  });
});

describe("the type lists", () => {
  test("each new type is in the property types, the field groups, the labels, the codes and the gallery", () => {
    for (const key of NEW_TYPES) {
      expect(Rules.PROPERTY_TYPES).toContain(key);
      expect(Describe.TYPE_LABELS[key]).toHaveLength(2);
      expect(UnitCode.TYPE_LETTER[key]).toMatch(/^[A-Z]$/);
      expect(Gallery.TYPES).toContain(key);
    }
  });

  test("unit codes: the new types have their own letters (townhouse and twinhouse already share T)", () => {
    const letters = NEW_TYPES.map((k) => UnitCode.TYPE_LETTER[k]);
    expect(new Set(letters).size).toBe(letters.length);
    for (const k of NEW_TYPES) {
      const sharers = Object.keys(UnitCode.TYPE_LETTER).filter((other) => other !== k && UnitCode.TYPE_LETTER[other] === UnitCode.TYPE_LETTER[k]);
      expect(sharers).toEqual([]);
    }
    expect(UnitCode.format("NH", "triplex", 4)).toBe("NH-X4");
    expect(UnitCode.format("NH", "sky_loft", 5)).toBe("NH-K5");
    expect(UnitCode.format("NH", "basement", 6)).toBe("NH-B6");
    expect(UnitCode.format("NH", "mazonette", 7)).toBe("NH-M7");
  });

  test("field groups: triplex, triplex with roof, sky loft, basement and mazonette are apartment-like", () => {
    for (const key of NEW_TYPES) expect(Rules.unitKind(key)).toBe("apartment");
    expect(Rules.unitKind("villa")).toBe("villa");
    for (const k of ["i_villa", "twin_villa", "maisonette"]) expect(Rules.unitKind(k)).toBe("villa");
    expect(Rules.unitKind("apartment")).toBe("apartment");
  });
});

describe("the import draft", () => {
  const base = { code: "TX-1", price_value: "3500000", area_value: "140" };

  test("a triplex row is recognised and gets no unrecognized-type error", () => {
    const out = SheetImport.rowToDraft({ ...base, property_type: "تريبلكس" });
    expect(out.draft.property_type).toBe("triplex");
    expect(out.errors).not.toContain("property_type");
  });

  test("a 'ground with garden' row is an apartment with the private garden feature", () => {
    const out = SheetImport.rowToDraft({ ...base, property_type: "Ground with garden" });
    expect(out.draft.property_type).toBe("apartment");
    expect(out.draft.feature_keys).toContain("private_garden");
    expect(out.errors).not.toContain("property_type");
  });

  test("a plain apartment row does not get the garden feature", () => {
    const out = SheetImport.rowToDraft({ ...base, property_type: "apartment" });
    expect(out.draft.feature_keys || []).not.toContain("private_garden");
  });
});
