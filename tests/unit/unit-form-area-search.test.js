"use strict";

// Area and sub-zone can be searched by either language or an alias, with an example in the box.
const { unitForm } = require("../../web/views/unitForm");

const areas = [
  { id: "1", parent_id: null, name_en: "New Cairo", name_ar: "القاهرة الجديدة", aliases: ["التجمع"] },
  { id: "2", parent_id: "1", name_en: "Al Banafseg", name_ar: "حي البنفسج", aliases: ["El Banafseg"] }
];

test("area and sub-zone options carry both names and aliases, and each box has an example", () => {
  const html = String(unitForm({ lang: "en", csrf: "x", areas, values: {}, extraValues: { feature: [], features: [], compound_new: "1" }, mode: "new" }));
  expect(html).toContain('data-search="New Cairo | القاهرة الجديدة | التجمع"');
  expect(html).toContain('data-search="Al Banafseg | حي البنفسج | El Banafseg"');
  expect(html).toContain('data-option-filter="area_id"');
  expect(html).toContain('data-option-filter="subzone_id"');
  expect(html).toContain("e.g. New Cairo");
});
