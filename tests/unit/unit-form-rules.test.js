"use strict";

// The add/edit form shows only the fields that fit the unit, and the server enforces the same: a sale has no rent period, a
// rental has no delivery date or payment plan. "Roof" (روف) is a unit type that carries the roof feature.
const Form = require("../../web/forms/unitForm");
const Rules = require("../../domain/fieldRules");
const Features = require("../../domain/features");
const Describe = require("../../domain/describe");
const UnitCode = require("../../domain/unitCode");
const Gallery = require("../../domain/gallery");
const SheetImport = require("../../domain/sheetImport");
const { TYPE_TERMS } = require("../../domain/vocabulary");
const { unitForm } = require("../../web/views/unitForm");

const view = (over = {}) =>
  String(unitForm({ lang: "en", csrf: "x", areas: [], mode: "new", values: Form.formFromUnit({ market: "resale" }), ...over }));

describe("sale and rent", () => {
  const body = {
    price_value: "9000000", area_value: "120", bedrooms: "3", is_ready: "1", delivery_year: "2027", delivery_quarter: "2",
    down_payment_value: "2000000", remaining_amount: "7000000", installment_value: "100000", payment_frequency: "monthly",
    installments_end: "2031-01", maintenance_pct: "8", rent_period: "monthly", developer: "Hyde", project: "Park"
  };

  test("a rental keeps its rent period and drops delivery, payment and developer terms", () => {
    const f = Form.unitFromForm({ ...body, listing_type: "rent", cash_price: "5", plan_down_1: "10", plan_years_1: "8" });
    expect(f.details.rent_period).toBe("monthly");
    for (const k of ["is_ready", "delivery_year", "delivery_quarter", "down_payment_value", "remaining_amount", "installment_value", "payment_frequency", "installments_end", "maintenance_pct"]) expect(f[k]).toBeNull();
    expect(f.payment_terms).toEqual({});
    expect(f.details.project).toBeNull();
    expect(f.details.developer).toBeNull();
    expect(f.price_value).toBe(9000000);
  });

  test("a sale drops the rent period and keeps delivery and payment", () => {
    const f = Form.unitFromForm({ ...body, listing_type: "sale" });
    expect(f.details.rent_period).toBeNull();
    expect(f.delivery_year).toBeNull(); // ready to move wins over a delivery year
    expect(f.down_payment_value).toBe(2000000);
    expect(f.remaining_amount).toBe(7000000);
  });

  test("the page puts the rules on the markup", () => {
    const html = view();
    expect(html).toMatch(/<label[^>]*data-show-if="listing_type=rent"[^>]*>Rent period/);
    expect(html).toMatch(/<section[^>]*data-step="3"[^>]*data-hide-if="listing_type=rent"/);
    expect(html).toMatch(/data-tabs="pay"[^>]*data-hide-if="listing_type=rent"/);
    expect(html).toContain('data-show-types="');
    expect(html).toMatch(/<label[^>]*data-show-types="[^"]*villa[^"]*"[^>]*>Land area/);
    expect(html).not.toMatch(/data-show-types="[^"]*\bapartment\b[^"]*"[^>]*>Land area/);
  });

  test("a house has no floor, land is only for houses and land", () => {
    expect(Rules.FIELD_TYPES.floor_level).not.toContain("villa");
    expect(Rules.FIELD_TYPES.floor_level).toContain("apartment");
    expect(Rules.FIELD_TYPES.land_area).toEqual(expect.arrayContaining(["villa", "twin_villa", "land"]));
    expect(Rules.FIELD_TYPES.land_area).not.toContain("apartment");
  });
});

describe("roof unit type", () => {
  test("is a type with its field group, label, code letter and gallery slot", () => {
    expect(Rules.PROPERTY_TYPES).toContain("roof");
    expect(Rules.unitKind("roof")).toBe("apartment");
    expect(Describe.TYPE_LABELS.roof).toEqual(["روف", "Roof unit"]);
    expect(UnitCode.TYPE_LETTER.roof).toBe("F");
    expect(Gallery.TYPES).toContain("roof");
  });

  test("is offered in the form's type list", () => {
    expect(view()).toContain('<option value="roof">Roof unit</option>');
    expect(view({ lang: "ar" })).toContain('<option value="roof">روف</option>');
  });

  test("is recognised by name in the import and the search words, without taking over other types", () => {
    expect(TYPE_TERMS.roof).toEqual(expect.arrayContaining(["روف", "roof"]));
    expect(SheetImport.propertyType("روف")).toBe("roof");
    expect(SheetImport.propertyType("Roof")).toBe("roof");
    expect(SheetImport.propertyType("apartment with roof")).toBe("apartment");
    expect(SheetImport.propertyType("بنتهاوس روف")).toBe("penthouse");
    expect(SheetImport.propertyType("تريبلكس روف")).toBe("triplex_roof");
  });

  test("a roof unit has the roof feature, so a search for roof finds it", () => {
    expect(Features.withTypeKeys(["balcony"], "roof")).toEqual(["roof", "balcony"]);
    expect(Features.withTypeKeys(["balcony"], "apartment")).toEqual(["balcony"]);
    const composed = Form.composeFromForm({ form: Form.unitFromForm({ property_type: "roof", listing_type: "sale", price_value: "5000000", area_value: "90", bedrooms: "2" }) });
    expect(composed.feature_keys).toContain("roof");
  });
});
