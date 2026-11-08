"use strict";

const { termsFor } = require("../../services/mapPlaces");

describe("map search words", () => {
  test("a place is found by its own aliases and by approved search words that point to it", () => {
    const place = { name_en: "Al Burouj", aliases: ["Burouj Compound"] };
    const rows = [
      { term: "burouj", target: "Al Burouj" },
      { term: "sarai", target: "Sarai" },
    ];
    const text = termsFor(place, rows);
    expect(text).toContain("Burouj Compound");
    expect(text).toContain("burouj");
    expect(text).not.toContain("sarai");
  });

  test("the target name is matched without regard to capitals", () => {
    const rows = [{ term: "uptown", target: "uptown cairo" }];
    expect(termsFor({ name_en: "Uptown Cairo", aliases: [] }, rows)).toBe("uptown");
  });

  test("a place with nothing extra returns an empty string", () => {
    expect(termsFor({ name_en: "Mivida", aliases: null }, [])).toBe("");
  });
});
