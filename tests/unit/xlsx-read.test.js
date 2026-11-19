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

test("a vertical merge is filled down on rows that have data; horizontal merges are left alone", async () => {
  const wb = new ExcelJS.Workbook();
  const s = wb.addWorksheet("Merged");
  s.addRow(["compound", "code", "price"]);
  s.addRow(["Hyde Park", "A1", 1]);
  s.addRow([null, "A2", 2]);
  s.addRow([null, "A3", 3]);
  s.mergeCells("A2:A4");
  s.addRow(["Title across", null, null]);
  s.mergeCells("A5:C5");
  const out = await XlsxRead.readWorkbook(await ZipRead.open(new Blob([Buffer.from(await wb.xlsx.writeBuffer())])));
  expect(out.tabs[0].rows.map((r) => r.v[0])).toEqual(["compound", "Hyde Park", "Hyde Park", "Hyde Park", "Title across"]);
  expect(out.tabs[0].rows[4].v).toEqual(["Title across"]);
});

test("a label merged down from a header that is not on row 1 is not copied into the data rows", async () => {
  const wb = new ExcelJS.Workbook();
  const s = wb.addWorksheet("Offset");
  s.addRow(["Hyde Park inventory"]);
  s.addRow([null]);
  s.addRow(["code", "compound", "price"]);
  s.addRow(["A1", null, 1]);
  s.addRow(["A2", null, 2]);
  s.addRow(["A3", null, 3]);
  s.mergeCells("B3:B5");
  const out = await XlsxRead.readWorkbook(await ZipRead.open(new Blob([Buffer.from(await wb.xlsx.writeBuffer())])));
  const rows = out.tabs[0].rows;
  expect(rows.map((r) => r.v[0])).toEqual(["Hyde Park inventory", "code", "A1", "A2", "A3"]);
  expect(rows[2].v[1] ?? null).toBeNull();
  expect(rows[3].v[1] ?? null).toBeNull();
});

test("progress follows the bytes of the tabs (known from the zip directory) and ends complete", async () => {
  const zip = await ZipRead.open(new Blob([await workbook()]));
  const events = [];
  await XlsxRead.readWorkbook(zip, { onProgress: (p) => events.push(p) });
  const bytes = events.map((p) => p.bytesDone);
  expect([...bytes].sort((a, b) => a - b)).toEqual(bytes);
  expect(events[0].bytesTotal).toBeGreaterThan(0);
  expect(events[events.length - 1].bytesDone).toBe(events[0].bytesTotal);
});
