// tests/unit/search-ai-first.test.js — AI-first mode: the AI reads every search at no cost to the agency, the quick reader
// runs beside it, and the differences are kept; a failed AI read falls back honestly.
"use strict";

process.env.SEARCH_AI_FIRST = "true";
const Search = require("../../services/search");

const fakeAI = (answer, { fail = false } = {}) => {
  const calls = [];
  return {
    calls,
    generateWithCascade: async (req) => {
      calls.push(req);
      if (fail) throw Object.assign(new Error("down"), { code: "AI_DOWN" });
      return { text: JSON.stringify(answer), modelUsed: "fake", usage: {} };
    }
  };
};
const ANSWER = { intent: "search", language: "ar", filters: { property_types: ["apartment"], bedrooms_min: 3, compound: "Azad", price_max: 9000000 } };
const broker = { id: "b1", agency_id: "a1" };

afterAll(() => {
  process.env.SEARCH_AI_FIRST = "false";
});

test("a sure quick reading is still read by the AI, free of agency credits, and compared", async () => {
  const AI = fakeAI(ANSWER);
  const r = await Search.parseRequest(AI, { text: "شقة 3 غرف في ازاد", ctx: { broker } });
  expect(r.source).toBe("ai");
  expect(AI.calls).toHaveLength(1);
  expect(AI.calls[0].ctx.broker).toBeUndefined(); // no broker: no allowance check, no credit
  expect(r.local).toBeTruthy();
  expect(r.disagree).toEqual(["price_max"]);
});

test("a read the broker asked for is charged as before (the broker stays in the context)", async () => {
  const AI = fakeAI(ANSWER);
  await Search.parseRequest(AI, { text: "شقة 3 غرف في ازاد", ctx: { broker }, forceAi: true });
  expect(AI.calls[0].ctx.broker).toEqual(broker);
});

test("small talk never reaches the AI", async () => {
  const AI = fakeAI(ANSWER);
  await Search.parseRequest(AI, { text: "شكرا", ctx: {} });
  expect(AI.calls).toHaveLength(0);
});

test("when the AI fails the quick reading stands and says why", async () => {
  const AI = fakeAI(ANSWER, { fail: true });
  const r = await Search.parseRequest(AI, { text: "شقة بادجت 70000 في ازاد", ctx: {} });
  expect(r.source).toBe("fallback");
  expect(r.aiError).toBe("AI_DOWN");
  expect(r.parsed.filters.price_max).toBe(70000); // the budget word is known now
});

test("SEARCH_AI_FIRST=false goes back to the quick reader first", async () => {
  process.env.SEARCH_AI_FIRST = "false";
  const AI = fakeAI(ANSWER);
  const r = await Search.parseRequest(AI, { text: "شقة 3 غرف تحت 9 مليون", ctx: {} });
  expect(r.source).toBe("parser");
  expect(AI.calls).toHaveLength(0);
  process.env.SEARCH_AI_FIRST = "true";
});
