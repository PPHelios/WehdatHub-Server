// lib/importFailed.js — The Excel file of the rows an import did not take: the sheet's own values untouched (including
// any edits made on the review page), the tab and sheet row they came from, and one new last column with the reason.
// Fix the cells and upload the file again.
"use strict";

const ExcelJS = require("exceljs");
const SheetImport = require("../domain/sheetImport");

const LABEL = Object.fromEntries(SheetImport.COLUMNS.map(([key]) => [key, key]));

/**
 * @param {Object} payload - a stored Excel plan (items, rows, tabs)
 * @param {{ lang?: string }} opts
 * @returns {Promise<{ buffer: Buffer, count: number }>}
 */
async function failedRowsWorkbook(payload, { lang = "ar" } = {}) {
  const en = lang === "en";
  const bad = (payload.items || []).filter((i) => i.kind === "invalid" || i.kind === "forbidden");
  const byRow = new Map((payload.rows || []).map((r) => [r.rowNumber, r]));
  // Header words: the sheet's own where a tab used them, else the app's column key (which the next upload recognises).
  const own = {};
  for (const t of payload.tabs || []) for (const [key, word] of Object.entries(t.headers || {})) if (word && !own[key]) own[key] = word;
  const keys = [];
  for (const i of bad) for (const k of Object.keys(byRow.get(i.row)?.cells || {})) if (!keys.includes(k)) keys.push(k);
  const order = SheetImport.COLUMNS.map(([k]) => k);
  keys.sort((a, b) => order.indexOf(a) - order.indexOf(b));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(en ? "Not imported" : "مش متسجل");
  ws.views = [{ state: "frozen", ySplit: 1, rightToLeft: !en }];
  const header = [en ? "Tab" : "التاب", en ? "Sheet row" : "صف الشيت", ...keys.map((k) => own[k] || LABEL[k] || k), en ? "Reason" : "السبب"];
  ws.addRow(header).font = { bold: true };
  for (const i of bad) {
    const cells = byRow.get(i.row)?.cells || {};
    const reason = (i.reasons || []).join(" · ");
    ws.addRow([i.tab || "", i.sheet_row || "", ...keys.map((k) => (cells[k] === undefined || cells[k] === null ? null : cells[k])), reason]);
  }
  header.forEach((_, c) => (ws.getColumn(c + 1).width = c === header.length - 1 ? 50 : c < 2 ? 14 : 20));
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), count: bad.length };
}

module.exports = { failedRowsWorkbook };
