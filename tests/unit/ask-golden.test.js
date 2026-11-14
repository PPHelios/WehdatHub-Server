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
  expect(areas({ area_min: 110, area_max: 110, locations: ["العبور"] })).toEqual(["JAZEEL RESIDENCE:110"]);
  expect(areas({ area_min: 110, area_max: 110, locations: ["obour"] })).toEqual(["JAZEEL RESIDENCE:110"]);
  // "more than 120" is a minimum: every offer of 120 or more, cheapest first.
  expect(areas({ area_min: 120, locations: ["العبور"] })).toEqual(["Arabisk New Obour:130", "JAZEEL RESIDENCE:153"]);
  expect(areas({ area_min: 130, area_max: 130, locations: ["العبور الجديده"] })).toEqual(["Arabisk New Obour:130"]);
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
  const text = PA.clientText(PN.matchUnits(ALL, { area_min: 110, area_max: 110, locations: ["obour"] }), "en");
  expect(text).toBe("• JAZEEL RESIDENCE: 110 m² · 2,900,000 EGP · down payment 290,000 · about 27,187/month");
});

test("project names in several spellings", () => {
  expect(fuzzyMatch("شقه في جزيل ريزيدنس", [JAZEEL, ARABISK, PMC])).toEqual([JAZEEL]);
  expect(fuzzyMatch("apartment in jezel", [JAZEEL, ARABISK, PMC])).toEqual([JAZEEL]);
});

test("the prompt tells the model that offers in notes are data, so it never says 'not in our data' beside them", () => {
  const p = require("../../domain/assistant").prompt("شقه في العبور مقدم اقل من ٣ مليون", [], { lang: "ar", today: "2026-11-08" });
  expect(p).toMatch(/Offers written in project notes ARE the agency's data/);
  expect(p).toMatch(/never say "not in our data"/);
});

test("results are grouped by project, paged, and one area number is a minimum", async () => {
  const rows = [JAZEEL, ARABISK].map((p) => ({ ...p }));
  const pool = { query: async () => ({ rows }) };
  const r = await PA.projectResults(pool, "a", { area_min: 120 }, { perPage: 1 });
  expect(r.total_projects).toBe(2);
  expect(r.pages).toBe(2);
  expect(r.projects).toHaveLength(1);
  const p2 = await PA.projectResults(pool, "a", { area_min: 120 }, { perPage: 1, page: 2 });
  expect(p2.projects[0].project.name_en).not.toBe(r.projects[0].project.name_en);
  expect((await PA.projectResults(pool, "a", { area_min: 400 })).total_projects).toBe(0);
});
