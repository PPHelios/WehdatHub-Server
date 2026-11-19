// lib/importTemplate.js — The downloadable import templates: mandatory columns in red, optional in grey, a Read me sheet,
// and dummy sample rows (marked, to delete before uploading real data).
"use strict";

const ExcelJS = require("exceljs");

const RED = "FFB42318";
const GREY = "FF475467";

/**
 * @param {Object} o - { sheetName, headers, required: [header index], samples: [rows], text: [column numbers kept as text],
 *   readme: [[ar, en]], lists: { column number: [words the import reads] } (a dropdown on rows 2-500; other words are warned about,
 *   not refused), rtl: the sheet opens right to left }
 * @returns {Promise<Buffer>}
 */
async function build({ sheetName, headers, required, samples, text = [], readme = [], lists = {}, rtl = false }) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(sheetName, { views: [{ state: "frozen", ySplit: 1, rightToLeft: Boolean(rtl) }] });
  const head = sheet.addRow(headers);
  head.height = 30;
  head.eachCell((cell, n) => {
    const must = required.includes(n - 1);
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: must ? RED : GREY } };
    cell.alignment = { vertical: "middle", wrapText: true };
    cell.note = must ? "Mandatory / مطلوب" : "Optional / اختياري";
  });
  for (const r of samples) sheet.addRow(r);
  for (const n of text) sheet.getColumn(n).numFmt = "@";
  sheet.columns.forEach((c) => (c.width = 20));
  // A dropdown of the words the import reads (the cell can still hold any other word: it is only warned about).
  for (const [col, words] of Object.entries(lists)) {
    const formulae = [`"${words.join(",")}"`];
    for (let r = 2; r <= 500; r++) sheet.getCell(r, Number(col)).dataValidation = { type: "list", allowBlank: true, formulae, showErrorMessage: true, errorStyle: "warning", error: "Pick from the list / اختار من القايمة" };
  }

  const info = wb.addWorksheet("Read me");
  info.getColumn(1).width = 90;
  info.addRow(["Red column = mandatory · Grey column = optional   |   الأحمر مطلوب · الرمادي اختياري"]).font = { bold: true };
  info.addRow([`Mandatory: ${required.map((i) => headers[i]).join(" | ")}`]);
  info.addRow(["The sample rows are dummy data: delete them before you upload your own. / الصفوف التجريبية بيانات وهمية: امسحها قبل ما تحمل بياناتك."]);
  info.addRow([""]);
  for (const [ar, en] of readme) info.addRow([`${en}  /  ${ar}`]);
  info.getColumn(1).alignment = { wrapText: true, vertical: "top" };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { build };
