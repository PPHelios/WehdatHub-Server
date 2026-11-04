// tests/unit/search-parser-first.test.js — the local parser reads first; the AI is asked only when it is unsure.
// It also never turns an exclusion ("بدون مصعد") into a filter: the phrase is reported as not applied.
"use strict";

// This file tests the quick-reader-first mode (SEARCH_AI_FIRST=false); AI-first has its own file.
process.env.SEARCH_AI_FIRST = "false";

const Q = require("../../domain/searchQuery");
const Search = require("../../services/search");

const fakeAI = (answer) => {
  const calls = [];
  return {
    calls,
    generateWithCascade: async (req) => {
      calls.push(req.operationType);
      if (answer instanceof Error) throw answer;
      return { text: JSON.stringify(answer), modelUsed: "fake", usage: {} };
    }
  };
};
const AI_ANSWER = { intent: "search", language: "ar", filters: { property_types: ["apartment"], price_max: 4000000 } };

describe("the local reading says when it is unsure", () => {
  test.each([
    ["شقة 3 غرف في التجمع تحت 9 مليون", false],
    ["azad 2 br budget 70k", false],
    ["شقة 5000", true], // a number nobody used
    ["", true], // nothing understood
    ["عندي شقة في التجمع سعرها ٥ مليون", true], // sounds like a unit to add: the AI decides
    ["شقة في التجمع قريبة من النادي وفيها منظر حلو ومفيهاش مشاكل خالص وقريبة من الخدمات كلها", true] // long
  ])("%s → unsure: %s", (text, unsure) => {
    const m = Q.fallbackParse(text).meta;
    // An empty request is small talk, not a miss: it never goes to the AI either way.
    if (text === "") return expect(Q.fallbackParse(text).intent).toBe("other");
    expect(m.unsure).toBe(unsure);
  });

  test("small talk is not a miss", () => {
    expect(Q.fallbackParse("مرحبا").meta.unsure).toBe(false);
  });
});

describe("exclusions are reported, never applied", () => {
  test.each([
    ["شقة بدون مصعد", "بدون مصعد", "elevator"],
    ["شقة من غير جراج وحديقة", "من غير جراج", "parking"],
    ["شقة مش في الدور الاول", "مش في الدور الاول", null],
    ["شقة بالدور الاخير", "الدور الاخير", null],
    ["شقة للايجار قانون جديد", "قانون جديد", null]
  ])("%s", (text, phrase, feature) => {
    const r = Q.fallbackParse(text);
    expect(r.meta.unapplied.join(" ")).toContain(phrase.split(" ").slice(-1)[0]);
    if (feature) expect(r.filters.features).not.toContain(feature);
    expect(r.filters.floor_min).toBeNull();
    expect(r.filters.property_types).toEqual(["apartment"]);
  });

  test("'بدون تشطيب' and 'بدون فرش' stay real filters", () => {
    expect(Q.fallbackParse("شقة بدون تشطيب").filters.finishing).toContain("core_and_shell");
    expect(Q.fallbackParse("شقة بدون تشطيب").meta.unapplied).toEqual([]);
  });
});

describe("parseRequest: parser first, AI when unsure", () => {
  test("a sure reading makes no AI call", async () => {
    const AI = fakeAI(AI_ANSWER);
    const r = await Search.parseRequest(AI, { text: "شقة 3 غرف تحت 9 مليون" });
    expect(r.source).toBe("parser");
    expect(AI.calls).toEqual([]);
    expect(r.parsed.filters.price_max).toBe(9000000);
  });

  test("an unsure reading asks the AI and keeps both readings", async () => {
    const AI = fakeAI(AI_ANSWER);
    const r = await Search.parseRequest(AI, { text: "شقة 5000" });
    expect(r.source).toBe("ai");
    expect(AI.calls).toEqual(["search_parse"]);
    expect(r.local.filters.property_types).toEqual(["apartment"]);
    expect(r.ai.filters.price_max).toBe(4000000);
    expect(r.reasons).toContain("numbers_left");
    expect(r.parsed.meta.unapplied).toEqual([]);
  });

  test("forceAi asks the AI even when the parser is sure", async () => {
    const AI = fakeAI(AI_ANSWER);
    const r = await Search.parseRequest(AI, { text: "شقة 3 غرف تحت 9 مليون", forceAi: true });
    expect(r.source).toBe("ai");
    expect(AI.calls).toEqual(["search_parse"]);
  });

  test("the AI failing keeps the local reading and says so", async () => {
    const AI = fakeAI(new Error("down"));
    const r = await Search.parseRequest(AI, { text: "شقة 5000" });
    expect(r.source).toBe("fallback");
    expect(r.parsed.filters.property_types).toEqual(["apartment"]);
  });

  test("the AI switched off: the local reading stands and the AI is never called", async () => {
    const AI = fakeAI(AI_ANSWER);
    const r = await Search.parseRequest(AI, { text: "شقة 5000", aiAllowed: false });
    expect(r.source).toBe("parser");
    expect(AI.calls).toEqual([]);
  });
});
