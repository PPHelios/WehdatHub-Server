// tests/unit/sheet-template-roundtrip.test.js — the inventory template a manager downloads must import back unchanged.
// Found by QA 2026-11-17: "Code / الكود" and "Price / السعر" were not recognised, so the template was refused with
// "These columns are empty on every row: Code, Price".
"use strict";

const ImportTemplate = require("../../lib/importTemplate");
const Sheets = require("../../lib/sheets");
const SheetImport = require("../../domain/sheetImport");
const { TEMPLATE_HEADERS } = require("../../web/routes/imports");

test("every header of the downloadable template is recognised", () => {
  const unknown = TEMPLATE_HEADERS.filter((h) => !SheetImport.columnFor(h));
  expect(unknown).toEqual([]);
});

test("each bilingual header maps to the right field", () => {
  const want = {
    "Code / الكود": "code",
    "Compound / الكمبوند": "compound",
    "Property Type / النوع": "property_type",
    "Purpose / بيع او ايجار": "listing_type",
    "Price / السعر": "price_value",
    "Area (sqm) / المساحة": "area_value",
    "Floor / الدور": "floor",
    "Status / الحالة": "status",
    "Owner / المالك": "owner_name",
    "Owner phone / تليفون المالك": "owner_phone"
  };
  for (const [h, key] of Object.entries(want)) expect([h, SheetImport.columnFor(h)]).toEqual([h, key]);
});

test("single-language headers still map as before", () => {
  expect(SheetImport.columnFor("Price")).toBe("price_value");
  expect(SheetImport.columnFor("السعر")).toBe("price_value");
  expect(SheetImport.columnFor("Code")).toBe("code");
  expect(SheetImport.columnFor("random words here")).toBe(null);
});

test("the template with its sample rows imports back with no empty required column", async () => {
  const buf = await ImportTemplate.build({
    sheetName: "Inventory",
    headers: TEMPLATE_HEADERS,
    required: [1, 2, 3, 4, 5],
    samples: [["SAMPLE-1", "Hyde Park", "شقة", "بيع", "8.5 مليون", 150, 3, 2, 4, "تشطيب كامل", "2027 Q3", "3 مليون", "5.5 مليون", 250000, "ربع سنوي", "بحري", "التجمع الخامس", "متاحة", "أحمد", "01000000000", "x"]],
    text: [20],
    readme: [["a", "b"]]
  });
  const sheet = await Sheets.readInventorySheet(buf);
  expect(sheet.rows.length).toBe(1);
  expect(SheetImport.emptyRequired(sheet.rows)).toEqual([]);
  expect(sheet.mapped).toEqual(expect.arrayContaining(["code", "price_value", "area_value", "property_type", "listing_type"]));
});
