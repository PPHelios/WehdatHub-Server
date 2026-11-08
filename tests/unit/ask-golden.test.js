"use strict";

// Fixed Arabic/English questions against three kinds of notes. A change that breaks one of these answers fails CI.
const PN = require("../../domain/projectNotes");
const PA = require("../../services/projectAnswer");
const C = require("../../domain/projectClarify");
const { fuzzyMatch } = require("../../domain/projectNames");

const JAZEEL = {
  name: "جزيل ريزدنس", name_en: "JAZEEL RESIDENCE", district: "Obour", city: "Cairo",
  notes: "🔥 يونت 110 م الدور الاول سعرها = 2,900,000 مقدم 10% = 290,000 قسط شهري على 8 سنين = 27,187\n🔥 يونت 153 م سعرها = 4,100,000 مقدم 10% = 410,000 قسط شهري = 21,000 تقسيط 10 سنين"
};
const ARABISK = {
  name: "Arabisk New Obour", name_en: "Arabisk New Obour", district: "New Obour", city: "Cairo",
  notes: "شقة 130 م سعرها = 3,900,000 مقدم 5% = 195,000 تقسيط 8 سنين\nرسوم تأجير 120,000 جنيه سنويا"
};
const PMC = { name: "PMC Mall", name_en: "PMC Mall", district: "Sheikh Zayed", city: "Giza", notes: "مكتب 60 م سعرها = 6,000,000 مقدم 10% = 600,000 تقسيط 7 سنين" };
const ALL = [JAZEEL, ARABISK, PMC].map((project) => ({ project, units: PN.parseUnits(project.notes) }));
const areas = (f) => PN.matchUnits(ALL, f).map((h) => `${h.project.name_en}:${h.unit.area}`);

test("area and place, Arabic and English spellings", () => {
  expect(areas({ area_min: 110, locations: ["العبور"] })).toEqual(["JAZEEL RESIDENCE:110"]);
  expect(areas({ area_min: 110, locations: ["obour"] })).toEqual(["JAZEEL RESIDENCE:110"]);
  expect(areas({ area_min: 130, locations: ["العبور الجديده"] })).toEqual(["Arabisk New Obour:130"]);
});

test("budget, down payment and installment limits", () => {
  expect(areas({ price_max: 3000000 })).toEqual(["JAZEEL RESIDENCE:110"]);
  expect(areas({ max_down_payment: 250000 })).toEqual(["Arabisk New Obour:130"]);
  expect(areas({ max_installment: 22000, locations: ["العبور"] })).toEqual(["JAZEEL RESIDENCE:153"]);
});

test("a rental fee is not a unit offer", () => {
  expect(PN.parseUnits(ARABISK.notes)).toHaveLength(1);
  expect(C.findIssues(ARABISK.notes).map((i) => i.line)).toEqual(["رسوم تأجير 120,000 جنيه سنويا"]);
});

test("the calculated monthly installment is marked as calculated", () => {
  const hits = PN.matchUnits(ALL, { area_min: 130 });
  expect(PA.notesReply(hits, "en")).toContain("calculated, no interest");
});

test("client text carries no raw notes and no internal remarks", () => {
  const text = PA.clientText(PN.matchUnits(ALL, { area_min: 110, locations: ["obour"] }), "en");
  expect(text).toBe("• JAZEEL RESIDENCE: 110 m² · 2,900,000 EGP · down payment 290,000 · about 27,187/month");
});

test("project names in several spellings", () => {
  expect(fuzzyMatch("شقه في جزيل ريزيدنس", [JAZEEL, ARABISK, PMC])).toEqual([JAZEEL]);
  expect(fuzzyMatch("apartment in jezel", [JAZEEL, ARABISK, PMC])).toEqual([JAZEEL]);
});
