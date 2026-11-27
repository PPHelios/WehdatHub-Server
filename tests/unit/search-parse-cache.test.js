"use strict";
process.env.SEARCH_AI_FIRST = "true";
const { createLru } = require("../../lib/memoCache");
const Search = require("../../services/search");

const fakeAI = () => {
  const calls = [];
  return { calls, generateWithCascade: async (r) => (calls.push(r), { text: JSON.stringify({ intent: "search", language: "ar", filters: { property_types: ["apartment"] } }), modelUsed: "fake", usage: {} }) };
};
afterAll(() => {
  process.env.SEARCH_AI_FIRST = "false";
});

test("LRU evicts the least recently used and expires by TTL", () => {
  let t = 0;
  const c = createLru({ max: 2, ttlMs: 100, now: () => t });
  c.set("a", 1);
  c.set("b", 2);
  c.get("a");
  c.set("c", 3);
  expect(c.get("b")).toBeUndefined();
  expect(c.get("a")).toBe(1);
  t = 101;
  expect(c.get("a")).toBeUndefined();
});

test("query normalization folds Arabic variants, digits, spaces and case", () => {
  expect(Search.normalizeQuery("  شقّة   ٣ غرف في  الإسكندرية ")).toBe(Search.normalizeQuery("شقه 3 غرف في الاسكندريه"));
  expect(Search.normalizeQuery("3BR Apt")).toBe("3br apt");
});

test("a repeated query calls the AI once and counts a cache hit", async () => {
  const AI = fakeAI();
  const ctx = { broker: { id: "b1", agency_id: "a-cache", role: "broker" } };
  const before = Search.parseStats();
  const r1 = await Search.parseRequest(AI, { text: "شقة 3 غرف في ازاد", ctx });
  const r2 = await Search.parseRequest(AI, { text: "شقه  ٣ غرف في ازاد", ctx });
  expect(AI.calls).toHaveLength(1);
  expect(r2.parsed).toEqual(r1.parsed);
  const after = Search.parseStats();
  expect(after.ai - before.ai).toBe(1);
  expect(after.cache - before.cache).toBe(1);
  await Search.parseRequest(AI, { text: "شقة 3 غرف في ازاد", ctx: { broker: { ...ctx.broker, agency_id: "other" } } });
  expect(AI.calls).toHaveLength(2); // another agency never shares
});

test("local-first: place + type + budget understood locally skips the AI", async () => {
  const AI = fakeAI();
  const r = await Search.parseRequest(AI, { text: "شقة للبيع في التجمع الخامس بحد اقصى 5 مليون", ctx: {} });
  if (r.source === "parser") expect(AI.calls).toHaveLength(0);
  else console.warn("local parser was not sure for this phrase; skip check");
  expect(r.source).toBe("parser");
});
