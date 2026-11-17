// tests/unit/unit-photos-saving-text.test.js — QA 2026-11-17: the unit Save said "Uploading photos…" even with no photo.
"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "..", "web", "static", "unitPhotos.js"), "utf8");

test("both languages have a plain saving text for a save with no photos", () => {
  expect(src).toMatch(/sendingNone: "Saving…"/);
  expect(src).toMatch(/sendingNone: "بنحفظ…"/);
});

test("the stage shows the photo text only when photos are chosen", () => {
  expect(src).toMatch(/status\(form, chosen\(\)\.length \? T\.sending : T\.sendingNone\)/);
});
