"use strict";

// Spelling-proof project names: Arabic spelling variants, partial names and English spellings find the project; words
// every project shares do not.
const PN = require("../../domain/projectNames");
const A = require("../../domain/assistant");

const JAZEEL = { name: "جزيل ريزدنس", name_en: "JAZEEL RESIDENCE" };
const PARKS = ["Hyde Park", "Palm Park", "Lake Park", "Sun Park"].map((n) => ({ name: n, name_en: n }));

describe("project name matching", () => {
  test("an Arabic spelling variant finds the project (ريزيدنس vs ريزدنس)", () => {
    expect(PN.fuzzyMatch("شقه في جزيل ريزيدنس", [JAZEEL, ...PARKS])).toEqual([JAZEEL]);
  });

  test("a partial name finds the project", () => {
    expect(PN.fuzzyMatch("عايزه يونت 110 متر في جزيل", [JAZEEL])).toEqual([JAZEEL]);
  });

  test("an English spelling variant finds the project (Jezel vs Jazeel)", () => {
    expect(PN.fuzzyMatch("apartment in jezel", [JAZEEL])).toEqual([JAZEEL]);
  });

  test("a word every project shares does not identify one", () => {
    expect(PN.fuzzyMatch("residence", [JAZEEL])).toEqual([]);
    expect(PN.fuzzyMatch("ريزيدنس", [JAZEEL])).toEqual([]);
    expect(PN.fuzzyMatch("park", PARKS)).toEqual([]);
  });

  test("numbers and short words match nothing", () => {
    expect(PN.fuzzyMatch("110 م في", [JAZEEL])).toEqual([]);
  });

  test("the assistant uses the fuzzy match when no whole name is in the question", () => {
    expect(A.matchProjects("شقه في جزيل ريزيدنس", [JAZEEL]).map((p) => p.name_en)).toEqual(["JAZEEL RESIDENCE"]);
    // The whole name still wins when it is there.
    expect(A.matchProjects("when is Badya delivery", [{ name: "Badya" }, { name: "Mivida" }]).map((p) => p.name)).toEqual(["Badya"]);
  });
});
