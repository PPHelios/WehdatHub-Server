// tests/unit/sheet-read-grid.test.js — The server's own reading of an upload (the browser-less fallback and CSV) goes
// through the same grid mapping as the browser: every visible tab, columns by content, tab name as compound.
"use strict";

const ExcelJS = require("exceljs");
const Sheets = require("../../lib/sheets");

async function twoTabs() {
  const wb = new ExcelJS.Workbook();
  const a = wb.addWorksheet("Mivida");
  a.addRow(["Code", "Price", "Area", "Type"]);
  a.addRow(["M1", "5m", 120, "apartment"]);
  const b = wb.addWorksheet("Hyde Park");
  b.addRow(["banner"]);
  b.addRow(["Code", "Rent", "Size", "Type"]);
  b.addRow(["H1", 30000, 90, "studio"]);
  const hid = wb.addWorksheet("Secret");
  hid.addRow(["Code", "Price", "Area"]);
  hid.addRow(["S1", "1m", 50]);
  hid.state = "hidden";
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test("fallback: every visible tab is read, hidden tabs skipped, the tab name is the compound", async () => {
  const sheet = await Sheets.readInventoryGrid(await twoTabs(), { filename: "RENT list.xlsx" });
  expect(sheet.tabs.map((t) => t.name)).toEqual(["Mivida", "Hyde Park"]);
  expect(sheet.rows.map((r) => [r.tab, r.cells.code, r.cells.compound, r.cells.listing_type])).toEqual([
    ["Mivida", "M1", "Mivida", "rent"],
    ["Hyde Park", "H1", "Hyde Park", "rent"]
  ]);
  expect(sheet.rows[1].cells).toMatchObject({ price_value: 30000, area_value: 90 });
});

test("CSV goes through the same mapping (semicolons, Arabic headers, no compound from the tab)", async () => {
  const csv = "الكود;الكمبوند;السعر;المساحة;النوع\nA1;Hyde Park;5 مليون;120;apartment\nA2;Mivida;6 مليون;130;apartment\n";
  const sheet = await Sheets.readInventoryGrid(Buffer.from(csv, "utf8"), { filename: "units.csv" });
  expect(sheet.rows.map((r) => [r.cells.code, r.cells.compound, r.cells.price_value, r.cells.area_value])).toEqual([
    ["A1", "Hyde Park", "5 مليون", "120"],
    ["A2", "Mivida", "6 مليون", "130"]
  ]);
  expect(Sheets.csvGrid(Buffer.from(csv, "utf8"))[0].name).toBe("Sheet1");
});

test("not a workbook or not text is refused", async () => {
  await expect(Sheets.readInventoryGrid(Buffer.from("PK\x03\x04garbage"))).rejects.toMatchObject({ code: "NOT_XLSX" });
  await expect(Sheets.readInventoryGrid(Buffer.from([0x41, 0, 0, 0, 0x42]))).rejects.toMatchObject({ code: "NOT_TEXT" });
});
