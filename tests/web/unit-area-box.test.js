// tests/web/unit-area-box.test.js — The add-new-compound part of the unit form: Area and Sub-zone are one searchable box each
// (an input with suggestions, like the compound box) over a hidden select that carries the id the form sends.
"use strict";

const { unitForm } = require("../../web/views/unitForm");

const areas = [
  { id: "a-nc", name_en: "New Cairo", name_ar: "القاهرة الجديدة", aliases: ["NC", "التجمع"], parent_id: null },
  { id: "a-oct", name_en: "6th of October", name_ar: "6 أكتوبر", aliases: ["october"], parent_id: null },
  { id: "s-ban", name_en: "Al Banafseg", name_ar: "البنفسج", aliases: [], parent_id: "a-nc" },
  { id: "s-zay", name_en: "Sheikh Zayed", name_ar: "الشيخ زايد", aliases: [], parent_id: "a-oct" }
];
const render = (values = {}, lang = "en") =>
  String(unitForm({ values: { feature: [], compound_new: "1", ...values }, areas, lang, csrf: "x" }));
const boxOf = (page, name) => page.match(new RegExp(`<label[^>]*>[^<]*<input[^>]*data-area-input="${name}"[\\s\\S]*?</label>`))[0];

test("area and sub-zone are one searchable box each, with a suggestion list and a hidden select", () => {
  const page = render();
  for (const name of ["area_id", "subzone_id"]) {
    const box = boxOf(page, name);
    expect(box).toContain(`list="${name}-list"`);
    expect(box).toContain(`<datalist id="${name}-list">`);
    expect(box).toMatch(new RegExp(`<select name="${name}" hidden>`));
  }
  expect(page).not.toContain("data-option-filter");
  expect(page).not.toContain("area-filter");
});

test("every option can be found by both names and its aliases", () => {
  const box = boxOf(render(), "area_id");
  expect(box).toContain('data-search="New Cairo | القاهرة الجديدة | NC | التجمع"');
  expect(box).toContain('data-search="6th of October | 6 أكتوبر | october"');
});

test("a sub-zone option knows its area, so the list can show only that area's sub-zones", () => {
  const box = boxOf(render(), "subzone_id");
  expect(box).toContain('data-parent="a-nc" data-search="Al Banafseg | البنفسج"');
  expect(box).toContain('data-parent="a-oct" data-search="Sheikh Zayed | الشيخ زايد"');
});

test("the chosen area and sub-zone show by name in their boxes", () => {
  const page = render({ area_id: "a-nc", subzone_id: "s-ban" });
  expect(boxOf(page, "area_id")).toContain('value="New Cairo"');
  expect(boxOf(page, "subzone_id")).toContain('value="Al Banafseg"');
  expect(boxOf(page, "area_id")).toContain('<option value="a-nc" data-search="New Cairo | القاهرة الجديدة | NC | التجمع" selected>');
});

test("the page language does not change what can be searched", () => {
  for (const lang of ["en", "ar"]) {
    const box = boxOf(render({}, lang), "area_id");
    expect(box).toContain("القاهرة الجديدة");
    expect(box).toContain("New Cairo");
  }
});

test("the required star and the pick message are on the area box only", () => {
  const page = render();
  expect(boxOf(page, "area_id")).toContain('class="req"');
  expect(boxOf(page, "subzone_id")).not.toContain('class="req"');
  expect(boxOf(page, "area_id")).toContain("data-msg-pick=");
});

test("the review step waits for the form's own check (hx-sync replaces an older request)", () => {
  expect(render()).toContain('hx-sync="this:replace"');
});
