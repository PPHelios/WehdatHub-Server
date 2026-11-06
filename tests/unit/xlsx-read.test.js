// tests/unit/xlsx-read.test.js — The browser's workbook reader: every visible tab, one at a time, from a real .xlsx.
"use strict";

const ExcelJS = require("exceljs");
const ZipRead = require("../../web/static/zipread.js");
const XlsxRead = require("../../web/static/xlsxread.js");

async function workbook() {
  const wb = new ExcelJS.Workbook();
  const a = wb.addWorksheet("Villette");
  a.addRow(["code", "price", "note"]);
  a.addRow(["V1", 65000, "R&D <fast> \"x\""]);
  a.addRow([null, null, null]);
  a.addRow(["V2", "40k", "second"]);
  const hidden = wb.addWorksheet("Sheet103");
  hidden.addRow(["x"]);
  hidden.state = "hidden";
  wb.addWorksheet("Empty");
  const b = wb.addWorksheet("Mivida");
  b.getCell("C3").value = "far cell";
  b.getCell("A1").value = { formula: "1+1", result: 2 };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test("every visible tab with data is read; hidden and empty tabs are reported, not read", async () => {
  const zip = await ZipRead.open(new Blob([await workbook()]));
  const seen = [];
  const out = await XlsxRead.readWorkbook(zip, { onProgress: (p) => seen.push(p) });
  expect(out.tabs.map((t) => t.name)).toEqual(["Villette", "Mivida"]);
  expect(out.skipped).toEqual([{ name: "Sheet103", reason: "hidden" }, { name: "Empty", reason: "empty" }]);
  // Progress counts rows across the whole workbook: it never goes back, and ends with every row read.
  expect(seen.length).toBeGreaterThan(1);
  const rowsDone = seen.map((p) => p.rowsDone);
  expect([...rowsDone].sort((a, b) => a - b)).toEqual(rowsDone);
  const last = seen[seen.length - 1];
  expect(last.rowsDone).toBe(last.rowsTotal);
  expect(last.tabsDone).toBe(last.tabsTotal);
});

test("cells keep their column and row, text is decoded, numbers stay numbers, blank rows are dropped, formulas give their result", async () => {
  const out = await XlsxRead.readWorkbook(await ZipRead.open(new Blob([await workbook()])));
  const villette = out.tabs[0].rows;
  expect(villette.map((r) => r.n)).toEqual([1, 2, 4]);
  expect(villette[1].v).toEqual(["V1", 65000, 'R&D <fast> "x"']);
  expect(villette[2].v[1]).toBe("40k");
  const mivida = out.tabs[1].rows;
  expect(mivida[0]).toEqual({ n: 1, v: [2] });
  expect(mivida[1]).toEqual({ n: 3, v: [null, null, "far cell"] });
});

test("something that is not a workbook is refused", async () => {
  const wb = new ExcelJS.Workbook();
  await expect(XlsxRead.readWorkbook({ entries: [], text: async () => "" })).rejects.toMatchObject({ code: "NOT_XLSX" });
  expect(wb).toBeTruthy();
});
