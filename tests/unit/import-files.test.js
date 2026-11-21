// tests/unit/import-files.test.js — the Excel files written from a plan read back by the upload (headers and values).
"use strict";

const ExcelJS = require("exceljs");
const SheetImport = require("../../domain/sheetImport");
const { fixedRowsWorkbook, failedRowsWorkbook } = require("../../lib/importFailed");

const read = async (buffer) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  const header = ws.getRow(1).values.slice(1);
  const rows = [];
  ws.eachRow((row, n) => n > 1 && rows.push(row.values.slice(1)));
  return { header, rows };
};

// Every column the sheet writes must be read back as the same key, even with no tab header for it.
const keyOf = (word) => SheetImport.columnFor(word);

const plan = {
  tabs: [{ name: "Villette", headers: { area_value: "المساحه", price_value: "السعر" } }],
  discarded: [4],
  rows: [
    { rowNumber: 2, cells: { code: "VR21", price_value: 60000, area_value: 135, listing_type: "rent", details_text: "furnished" } },
    { rowNumber: 3, cells: { code: "VR22", price_value: 2800, area_value: 120, listing_type: "sale" } },
    { rowNumber: 4, cells: { code: "VR23", price_value: 1 } },
  ],
  items: [
    { row: 2, kind: "invalid", tab: "Villette", sheet_row: 5, reasons: ["Owner phone is required"] },
    { row: 3, kind: "new", tab: "Villette", sheet_row: 6, reasons: [] },
  ],
};

describe("fixedRowsWorkbook", () => {
  test("drops discarded rows and has no tab or reason column", async () => {
    const { header, rows } = await read((await fixedRowsWorkbook(plan)).buffer);
    expect(header).not.toContain("السبب");
    expect(header).not.toContain("صف الشيت");
    expect(rows.map((r) => r[header.indexOf("code")])).toEqual(["VR21", "VR22"]);
  });

  test("every header reads back as its own column (price, area and listing type included)", async () => {
    const { header } = await read((await fixedRowsWorkbook(plan)).buffer);
    const keys = header.map((h) => keyOf(h));
    expect(keys).toEqual(expect.arrayContaining(["price_value", "area_value", "listing_type", "details_text", "code"]));
    expect(keys.every((k) => k)).toBe(true);
  });
});

describe("failedRowsWorkbook", () => {
  test("keeps tab, sheet row and reason, and the same readable headers", async () => {
    const { header, rows } = await read((await failedRowsWorkbook(plan)).buffer);
    expect(header.slice(0, 2)).toEqual(["التاب", "صف الشيت"]);
    expect(header[header.length - 1]).toBe("السبب");
    expect(rows[0][header.length - 1]).toBe("Owner phone is required");
    expect(header.slice(2, -1).every((h) => keyOf(h))).toBe(true);
  });
});
