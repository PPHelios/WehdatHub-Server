// tests/unit/sheet-digits.test.js — Arabic-Indic digits profile like ASCII ones (X28); "16,000,000 m" is 16 million, not 16e12 (C01).
"use strict";

const SheetGrid = require("../../lib/sheetGrid");
const { money } = require("../../domain/sheetImport");

test("an area column written with Arabic-Indic digits is profiled as area, like the ASCII one", () => {
  expect(SheetGrid.profile(["120 sqm", "130 sqm", "140 sqm"]).area).toBe(1);
  expect(SheetGrid.profile(["١٢٠ sqm", "١٣٠ sqm", "١٤٠ sqm"]).area).toBe(1);
  expect(SheetGrid.profile(["٠١٠١٢٣٤٥٦٧٨", "٠١٠١٢٣٤٥٦٧٩"]).phone).toBe(1);
});

test("a price already written in full keeps its value when a stray unit follows it", () => {
  expect(money("16,000,000 m")).toBe(16000000);
  expect(money("16 m")).toBe(16000000);
  expect(money("8.5 مليون")).toBe(8500000);
});

// Chat posts reach the same money() through rowToDraft; values equal the pre-C01 (HEAD) results.
test("chat price text gives the same value as before the C01 change", () => {
  const { parsePost } = require("../../domain/chatListing");
  const { rowToDraft } = require("../../domain/sheetImport");
  const price = (p) => rowToDraft(parsePost(`شقة للبيع في التجمع 150 متر السعر ${p}`).cells).draft.price_value;
  expect(price("16 m")).toBe(16000000);
  expect(price("16,000,000")).toBe(16000000);
  expect(price("16,000,000 m")).toBe(16000000);
  expect(price("16 مليون")).toBe(16000000);
  expect(price("850 الف")).toBe(850000);
});
