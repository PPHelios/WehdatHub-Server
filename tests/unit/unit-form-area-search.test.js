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
  expect(html).toContain('data-area-input="area_id"');
  expect(html).toContain('data-area-input="subzone_id"');
  expect(html).toContain("e.g. New Cairo");
  expect(html).toContain("e.g. Al Banafseg");
  expect(html).not.toMatch(/placeholder="[^"]*[؀-ۿ]/); // an English page has no Arabic letters in a placeholder
});

test("sub-zone box is disabled until an area is picked", () => {
  const render = (values) => String(unitForm({ lang: "en", csrf: "x", areas, values, extraValues: { feature: [], features: [], compound_new: "1" }, mode: "new" }));
  expect(render({})).toMatch(/data-area-input="subzone_id"[^>]*disabled/);
  expect(render({ area_id: "1" })).not.toMatch(/data-area-input="subzone_id"[^>]*disabled/);
});

test("sub-zone options carry their parent id, so the client shows only the chosen area's children (none without an area)", () => {
  const two = [...areas, { id: "3", parent_id: null, name_en: "Giza", name_ar: "الجيزة", aliases: [] }, { id: "4", parent_id: "3", name_en: "Dokki", name_ar: "الدقي", aliases: [] }];
  const html = String(unitForm({ lang: "en", csrf: "x", areas: two, values: {}, extraValues: { feature: [], features: [], compound_new: "1" }, mode: "new" }));
  const subs = [...html.matchAll(/<option value="(\d+)" data-parent="(\d+)"/g)].map((m) => ({ id: m[1], parent: m[2] }));
  const under = (area) => subs.filter((o) => area !== "" && o.parent === area).map((o) => o.id); // same rule as fillAreaList/showAreaList
  expect(under("1")).toEqual(["2"]);
  expect(under("3")).toEqual(["4"]);
  expect(under("")).toEqual([]);
  const js = require("fs").readFileSync("web/static/app.js", "utf8");
  expect(js).toContain('o.getAttribute("data-parent") === under');
});

test("known-place fill fires the area change handler; the area list shows one row per place with parent on same names", () => {
  const js = require("fs").readFileSync("web/static/app.js", "utf8");
  expect(js).toMatch(/b\.areaSel\.value = hit\.area_id;[\s\S]*?b\.areaSel\.dispatchEvent\(new Event\("change"/);
  expect(js).toContain("count[normalizeArea(o.textContent)] > 1 && parent");
});
