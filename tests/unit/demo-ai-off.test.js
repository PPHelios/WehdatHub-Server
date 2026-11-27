// tests/unit/demo-ai-off.test.js — The store-review demo broker never reaches the AI: its calls throw AI_OFF before any credit is charged.
"use strict";

const AI = require("../../lib/ai");

const DEMO_ENV = {
  DEMO_LOGIN_ENABLED: "true",
  DEMO_LOGIN_PHONE: "201044556666",
  DEMO_LOGIN_AGENCY_ID: "a0000000-0000-0000-0000-000000000001"
};
const DEMO_ROW = { agency_id: DEMO_ENV.DEMO_LOGIN_AGENCY_ID, phone_normalized: DEMO_ENV.DEMO_LOGIN_PHONE };

// Pool that answers the broker lookup with `row`; any other query (quota, usage) is recorded and fails the test.
function poolWith(row) {
  const queries = [];
  return {
    queries,
    query: async (sql) => {
      queries.push(sql);
      if (/FROM brokers/.test(sql)) return { rows: row ? [row] : [] };
      throw new Error("no other query expected: " + sql);
    }
  };
}

const saved = {};
beforeAll(() => Object.assign(saved, process.env));
afterEach(() => {
  AI._setClientForTests(null);
  for (const k of Object.keys(DEMO_ENV)) delete process.env[k];
  Object.assign(process.env, saved);
});

const ask = (pool) => AI.generateWithCascade({ contents: "hi", operationType: "search_parse", ctx: { pool, broker: { id: "b-demo", agency_id: DEMO_ENV.DEMO_LOGIN_AGENCY_ID } } });

test("demo broker is refused with AI_OFF before any credit check", async () => {
  Object.assign(process.env, DEMO_ENV);
  const pool = poolWith(DEMO_ROW);
  await expect(ask(pool)).rejects.toMatchObject({ code: "AI_OFF" });
  expect(pool.queries).toHaveLength(1); // only the broker lookup ran
});

test("other brokers pass the demo rule (the fake pool then stops the run at the next gate)", async () => {
  Object.assign(process.env, DEMO_ENV);
  const pool = poolWith({ ...DEMO_ROW, phone_normalized: "201055881114" });
  const err = await ask(pool).catch((e) => e);
  expect(err.code).not.toBe("AI_OFF");
});

test("no demo lookup at all when DEMO_LOGIN_ENABLED is off", async () => {
  Object.assign(process.env, { ...DEMO_ENV, DEMO_LOGIN_ENABLED: "false" });
  const pool = poolWith(DEMO_ROW);
  const err = await ask(pool).catch((e) => e);
  expect(err.code).not.toBe("AI_OFF");
  expect(pool.queries.some((q) => /FROM brokers/.test(q))).toBe(false);
});
