// tests/unit/xlsx-parts.test.js — The browser splits a workbook of more rows than one import takes into parts (XlsxRead.splitParts).
"use strict";

const XlsxRead = require("../../web/static/xlsxread.js");

const HEADER = { n: 1, v: ["code", "compound", "price", "area", "type", "bedrooms", "bathrooms", "details", "note"] };
const data = (count, start = 2) => Array.from({ length: count }, (_, i) => ({ n: start + i, v: ["V" + i, 1000 + i] }));
const tab = (name, rows) => ({ name, rows: [HEADER, ...rows] });
const counts = (parts) => parts.map((p) => p.reduce((n, t) => n + t.rows.length, 0));

test("a file within the cap is one part, untouched", () => {
  const tabs = [tab("A", data(10)), tab("B", data(20))];
  const parts = XlsxRead.splitParts(tabs);
  expect(parts).toHaveLength(1);
  expect(parts[0]).toEqual(tabs);
});

test("whole tabs stay whole: a tab that does not fit starts the next part, a small one joins it", () => {
  const A = tab("A", data(2999)); // 3000 rows with the header
  const B = tab("B", data(3998)); // 3999 rows
  const C = tab("C", data(999)); // 1000 rows
  const parts = XlsxRead.splitParts([A, B, C]);
  expect(parts.map((p) => p.map((t) => t.name))).toEqual([["A"], ["B", "C"]]);
  expect(parts[1][0].rows).toEqual(B.rows);
});

test("a tab above the part cap is cut by rows, and every later part repeats the header rows", () => {
  const big = tab("Big", data(11999));
  const parts = XlsxRead.splitParts([big]);
  expect(counts(parts)).toEqual([5000, 5000, 2002]);
  for (const p of parts) {
    expect(p).toHaveLength(1);
    expect(p[0].name).toBe("Big");
    expect(p[0].rows[0]).toEqual(HEADER);
  }
  const dataRows = parts.flatMap((p) => p[0].rows.slice(1));
  expect(dataRows.map((r) => r.n)).toEqual(data(11999).map((r) => r.n));
});

test("the header is the row with the most text, and the rows above it are repeated too", () => {
  const labels = { n: 1, v: ["Payment"] };
  const head = { n: 2, v: ["code", "compound", "price", "area", "type", "bedrooms", "bathrooms", "details", "note"] };
  const parts = XlsxRead.splitParts([{ name: "L", rows: [labels, head, ...data(6000, 3)] }]);
  expect(parts).toHaveLength(2);
  expect(parts[1][0].rows.slice(0, 2)).toEqual([labels, head]);
});

test("a big tab after a part that is partly full fills it first, then goes on in the next part", () => {
  const A = tab("A", data(2000));
  const B = tab("B", data(6000));
  const parts = XlsxRead.splitParts([A, B]);
  expect(counts(parts)).toEqual([5000, 3003]); // 2999 of B fill part 1; part 2 repeats B's header
  expect(parts[0].map((t) => t.name)).toEqual(["A", "B"]);
  expect(parts[1]).toHaveLength(1);
  expect(parts[1][0].rows[0]).toEqual(HEADER);
});

test("the whole file: 30000 rows and 60 tabs are allowed; more is refused", () => {
  const six = Array.from({ length: 6 }, (_, i) => tab("T" + i, data(4999))); // 6 x 5000 rows
  expect(counts(XlsxRead.splitParts(six))).toEqual([5000, 5000, 5000, 5000, 5000, 5000]);
  expect(() => XlsxRead.splitParts([tab("X", data(29999))])).not.toThrow(); // 30000 rows with the header
  expect(() => XlsxRead.splitParts([tab("X", data(30000))])).toThrow("too large"); // 30001 rows
  const many = Array.from({ length: 61 }, (_, i) => tab("t" + i, data(1)));
  expect(() => XlsxRead.splitParts(many)).toThrow("too large");
  expect(XlsxRead.splitParts(many.slice(0, 60)).flat()).toHaveLength(60);
});

test("no part is above the per-import row cap", () => {
  const tabs = [tab("A", data(4000)), tab("B", data(4500)), tab("C", data(700)), tab("D", data(9000))];
  for (const p of XlsxRead.splitParts(tabs)) expect(p.reduce((n, t) => n + t.rows.length, 0)).toBeLessThanOrEqual(XlsxRead.PART_ROWS);
});
