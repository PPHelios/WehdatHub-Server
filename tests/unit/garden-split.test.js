// tests/unit/garden-split.test.js — an area cell that also carries the garden (English or Arabic, any order).
"use strict";

const Mixed = require("../../domain/sheetMixed");

describe("gardenSplit", () => {
  test.each([
    ["135/30", 135, 30],
    ["135/30 garden", 135, 30],
    ["135 garden 30", 135, 30],
    ["garden 30 / 135", 135, 30],
    ["135 م جنينة 30 م", 135, 30],
    ["جنينه 30 و 135", 135, 30],
    ["135 جاردن 30", 135, 30],
    ["١٣٥ جنينة ٣٠", 135, 30],
    ["135 m2 garden 30 m2", 135, 30],
  ])("%s → area %s, garden %s", (text, area, garden) => {
    expect(Mixed.gardenSplit(text)).toEqual({ area, garden });
  });

  test("a slash pair with no garden word is split only when the second figure is smaller", () => {
    expect(Mixed.gardenSplit("120/130")).toBeNull();
    expect(Mixed.gardenSplit("120 / 130 garden")).toEqual({ area: 120, garden: 130 });
  });

  test("a bare number or a lone garden figure is not split", () => {
    expect(Mixed.gardenSplit("13530")).toBeNull();
    expect(Mixed.gardenSplit("garden 80")).toBeNull();
    expect(Mixed.gardenSplit("135 30")).toBeNull();
  });
});
