// lib/importFailed.js — Excel files written from an import plan, both read back by the next upload:
//  - failedRowsWorkbook: the rows the import did not take, with the tab and sheet row they came from and a Reason column.
//  - fixedRowsWorkbook: the whole sheet as it stands after the fixes made on the review page (no tab, no reason).
// The header of a column is the sheet's own word where the tab had one, else a word the upload recognises.
"use strict";

const ExcelJS = require("exceljs");
const SheetImport = require("../domain/sheetImport");

// Header words for the columns a tab may not have had: each is read back by SheetImport.columnFor (en, ar). Other keys are read as themselves.
const FALLBACK = { price_value: ["Price", "السعر"], area_value: ["Area", "المساحه"], listing_type: ["Sale or rent", "بيع او ايجار"], details_text: ["Details", "التفاصيل"] };

/**
 * One sheet: a header row, then one row per entry of `rows` ({ cells, tab?, sheetRow?, reason? }). `withReason` adds the
 * tab, sheet row and reason columns (the failed-rows file).
 */
async function writeSheet(payload, rows, { lang = "ar", withReason = false } = {}) {
  const en = lang === "en";
  const own = {};
  for (const t of payload.tabs || []) for (const [key, word] of Object.entries(t.headers || {})) if (word && !own[key]) own[key] = word;
  const keys = [];
  for (const r of rows) for (const k of Object.keys(r.cells || {})) if (!keys.includes(k)) keys.push(k);
  const order = SheetImport.COLUMNS.map(([k]) => k);
  keys.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const words = keys.map((k) => own[k] || (FALLBACK[k] ? FALLBACK[k][en ? 0 : 1] : k));
  const header = withReason ? [en ? "Tab" : "التاب", en ? "Sheet row" : "صف الشيت", ...words, en ? "Reason" : "السبب"] : words;

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(withReason ? (en ? "Not imported" : "مش متسجل") : (en ? "Fixed sheet" : "الشيت بعد التعديل"));
  ws.views = [{ state: "frozen", ySplit: 1, rightToLeft: !en }];
  ws.addRow(header).font = { bold: true };
  for (const r of rows) {
    const values = keys.map((k) => (r.cells[k] === undefined || r.cells[k] === null ? null : r.cells[k]));
    ws.addRow(withReason ? [r.tab || "", r.sheetRow || "", ...values, r.reason || ""] : values);
  }
  header.forEach((_, c) => (ws.getColumn(c + 1).width = withReason && c === header.length - 1 ? 50 : 20));
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), count: rows.length };
}

/**
 * @param {Object} payload - a stored Excel plan (items, rows, tabs)
 * @param {{ lang?: string }} opts
 * @returns {Promise<{ buffer: Buffer, count: number }>}
 */
function failedRowsWorkbook(payload, { lang = "ar" } = {}) {
  const byRow = new Map((payload.rows || []).map((r) => [r.rowNumber, r]));
  const bad = (payload.items || [])
    .filter((i) => i.kind === "invalid" || i.kind === "forbidden")
    .map((i) => ({ cells: byRow.get(i.row)?.cells || {}, tab: i.tab, sheetRow: i.sheet_row, reason: (i.reasons || []).join(" · ") }));
  return writeSheet(payload, bad, { lang, withReason: true });
}

/**
 * The whole sheet as it stands after the fixes made on the review page (batch changes, picked prices, type words): every row
 * except the discarded ones, no tab or reason column. Upload it again: the fixed cells match, nothing to re-fix.
 * @returns {Promise<{ buffer: Buffer, count: number }>}
 */
function fixedRowsWorkbook(payload, { lang = "ar" } = {}) {
  const thrown = new Set((payload.discarded || []).map(Number));
  const rows = (payload.rows || []).filter((r) => !thrown.has(Number(r.rowNumber)));
  return writeSheet(payload, rows, { lang });
}

/**
 * What an apply would change: one line per changed field (Code, Tab, Row, Field, From, To), for rows kind "changed".
 * @returns {Promise<{ buffer: Buffer, count: number }>}
 */
async function diffRowsWorkbook(payload, { lang = "ar" } = {}) {
  const en = lang === "en";
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(en ? "Changes" : "التغييرات");
  ws.views = [{ state: "frozen", ySplit: 1, rightToLeft: !en }];
  const header = en ? ["Code", "Tab", "Row", "Field", "From", "To"] : ["الكود", "التاب", "الصف", "الخانة", "من", "إلى"];
  ws.addRow(header).font = { bold: true };
  let count = 0;
  for (const i of payload.items || []) {
    if (i.kind !== "changed") continue;
    for (const c of i.changes || []) {
      ws.addRow([i.code || "", i.tab || "", i.sheet_row || i.row, c.label ?? c.field, c.from ?? "", c.to ?? ""]);
      count++;
    }
  }
  header.forEach((_, c) => (ws.getColumn(c + 1).width = c >= 3 ? 28 : 14));
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), count };
}

module.exports = { failedRowsWorkbook, fixedRowsWorkbook, diffRowsWorkbook };
