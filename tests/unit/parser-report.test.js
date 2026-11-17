// tests/unit/parser-report.test.js — the weekly parser agreement report (pure).
"use strict";

const { summarizeReads, summarizeSearch, renderReport } = require("../../domain/parserReport");

const reads = [
  { status: "ok", metadata: { parser: "add_unit_text", read: ["price_value"], empty: ["bedrooms"], agree: ["price_value", "area_value"], differ: ["bedrooms"] } },
  { status: "ok", metadata: { parser: "add_unit_text", read: ["price_value"], empty: [], agree: ["price_value"], differ: [] } },
  { status: "error", metadata: { parser: "catalogue_update", read: [], empty: ["not_understood"] } },
];

test("per parser: runs, errors, agreement, worst field first, empty rate", () => {
  const out = summarizeReads(reads);
  const add = out.find((p) => p.parser === "add_unit_text");
  expect(add).toMatchObject({ runs: 2, errors: 0, agreement: 75 });
  expect(add.perField[0]).toMatchObject({ field: "bedrooms", agreement: 0 });
  expect(add.emptyTop[0]).toMatchObject({ field: "bedrooms", n: 1, rate: 50 });
  expect(out.find((p) => p.parser === "catalogue_update")).toMatchObject({ runs: 1, errors: 1, agreement: null });
});

test("search: disagreement per filter among the searches both read", () => {
  const s = summarizeSearch([
    { source: "ai", disagree: ["price_max"] },
    { source: "ai", disagree: [] },
    { source: "parser", disagree: [] },
  ]);
  expect(s).toMatchObject({ total: 3, withAi: 2, disagreed: 1, agreement: 50 });
  expect(s.perFilter[0]).toMatchObject({ filter: "price_max", n: 1 });
});

test("the page is plain text and carries no logged text", () => {
  const page = renderReport({ days: 7, reads, search: [] });
  expect(page).toContain("add_unit_text: 2 runs");
  expect(page).toContain("bedrooms");
  expect(renderReport({}).includes("No parser_read rows")).toBe(true);
});
