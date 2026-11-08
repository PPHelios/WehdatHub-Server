"use strict";

// Offers written in project notes: how each offer is read, and which offers fit a search (area, place, budget, installment).
const PN = require("../../domain/projectNotes");

const NOTES = "خبر عاجل! 🔥يونت 153م الدور الاول سعرها بعد خصم 15% =3,180,590 مقدم 5% = 159,029 4 دفعات 5% = 159,029 قسط شهري علي 9 سنين = 22,087 __ 🔥يونت 146 الدور الاول سعرها بعد خصم 15% = 3,724,930 مقدم 5% = 186,246 4 دفعات 5% = 186,246 قسط شهري علي 9 سنين = 25,867 __ 🔥يونت ١١٠ الدور التاني سعرها بعد خصم 15% = 2,862,554 مقدم 5% = 143,127";

const JAZEEL = {
  name: "جزيل ريزدنس",
  name_en: "JAZEEL RESIDENCE",
  district: "obour",
  city: "cairo",
  updated_at: "2026-11-07T10:00:00Z"
};

describe("offers in project notes", () => {
  test("each offer line is read with its area, price, down payment and installment", () => {
    const units = PN.parseUnits(NOTES);
    expect(units.map((u) => u.area)).toEqual([153, 146, 110]);
    expect(units[0]).toMatchObject({ price: 3180590, down: 159029, monthly: 22087, years: 9 });
    expect(units[2]).toMatchObject({ area: 110, price: 2862554, down: 143127, floor: "التاني" });
  });

  test("a place of the request matches the project's district (Arabic or English)", () => {
    expect(PN.matchesPlace(JAZEEL, ["obour"])).toBe(true);
    expect(PN.matchesPlace(JAZEEL, ["العبور"])).toBe(true);
    expect(PN.matchesPlace(JAZEEL, ["new cairo"])).toBe(false);
    expect(PN.matchesPlace(JAZEEL, [])).toBe(true);
  });

  test("apartment 110 m in Obour finds the 110 m offer", () => {
    const hits = PN.matchUnits([{ project: JAZEEL, units: PN.parseUnits(NOTES) }], { area_min: 110, area_max: null, locations: ["obour"] });
    expect(hits.map((h) => h.unit.area)).toEqual([110]);
  });

  test("a budget is a price ceiling and an installment cap is checked against the monthly amount", () => {
    const all = [{ project: JAZEEL, units: PN.parseUnits(NOTES) }];
    expect(PN.matchUnits(all, { price_max: 3000000 }).map((h) => h.unit.area)).toEqual([110]);
    expect(PN.matchUnits(all, { max_installment: 23000 }).map((h) => h.unit.area)).toEqual([153]);
  });

  test("a request with nothing specific (no area, place, budget or installment) lists no notes offers", () => {
    expect(PN.matchUnits([{ project: JAZEEL, units: PN.parseUnits(NOTES) }], { installments: true })).toEqual([]);
  });

  test("rent searches are not answered from notes", () => {
    expect(PN.matchUnits([{ project: JAZEEL, units: PN.parseUnits(NOTES) }], { listing_type: "rent" })).toEqual([]);
  });
});

describe("calculated installment and new place names", () => {
  test("monthly is estimated from price, down payment and years when not written", () => {
    const [u] = PN.parseUnits("وحدة 120 م سعرها = 4,800,000 مقدم 10% = 480,000 تقسيط 8 سنين");
    expect(u).toMatchObject({ monthly: null, monthly_est: 45000 });
    expect(PN.matchUnits([{ project: JAZEEL, units: [u] }], { max_installment: 46000 })).toHaveLength(1);
    expect(PN.matchUnits([{ project: JAZEEL, units: [u] }], { max_installment: 40000 })).toHaveLength(0);
  });

  test("new capital and new Obour spellings find the place", () => {
    expect(PN.matchesPlace({ city: "New Administrative Capital" }, ["العاصمه الاداريه"])).toBe(true);
    expect(PN.matchesPlace({ district: "New Obour" }, ["العبور"])).toBe(true);
  });
});
