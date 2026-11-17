// tests/unit/parser-log.test.js — the shared parser log row (plan section 7a): masked text, field names only, never throws.
"use strict";

const { readAlongside, logParserRead } = require("../../services/parserLog");

describe("readAlongside", () => {
  test("reads the post with the rules and compares with the AI fields by name", () => {
    const r = readAlongside("شقة للبيع 3 غرف 150 متر 4 مليون", { price_value: 4000000, bedrooms: 3, area_value: 999 });
    expect(r.read.length).toBeGreaterThan(0);
    expect(r.agree).toEqual(expect.arrayContaining(["price_value", "bedrooms"]));
    expect(r.differ).toContain("area_value");
  });
  test("without AI fields nothing is compared", () => {
    const r = readAlongside("شقة 3 غرف", null);
    expect(r.agree).toEqual([]);
    expect(r.differ).toEqual([]);
  });
});

describe("logParserRead", () => {
  test("writes a parser_read row with the phone number masked and no values for agreement", async () => {
    const calls = [];
    const pool = { query: (sql, params) => (calls.push(params), Promise.resolve({ rows: [] })) };
    logParserRead(pool, { agency_id: "a1", broker_id: "b1", parser: "add_unit_text", kind: "web", text: "شقة 3 غرف اتصل 01012345678", result: { read: ["bedrooms"], agree: ["bedrooms"], differ: [], missing: ["price_value"], ms: 3 } });
    await new Promise((r) => setImmediate(r));
    expect(calls.length).toBe(1);
    const flat = JSON.stringify(calls[0]);
    expect(flat).toContain("parser_read");
    expect(flat).toContain("add_unit_text");
    expect(flat).not.toContain("01012345678");
  });
  test("never throws", () => {
    expect(() => logParserRead(null, {})).not.toThrow();
    expect(() => logParserRead({ query: () => { throw new Error("db down"); } }, { agency_id: "a", parser: "x" })).not.toThrow();
    expect(() => logParserRead({ query: () => Promise.reject(new Error("db down")) }, { agency_id: "a", parser: "x" })).not.toThrow();
  });
});
