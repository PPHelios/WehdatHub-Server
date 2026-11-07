// tests/web/query-plans.test.js — Query plans on 50,000 units (patch 5): the units list, the code lookup and the compound filter use
// indexes, and the paged list answers fast, with another agency's units in the same table.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");

jest.setTimeout(280000);

let h;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const plan = async (sql, params) => (await h.query(`EXPLAIN ${sql}`, params)).map((r) => r["QUERY PLAN"]).join("\n");

test("on 50,000 units the main list queries use indexes and answer fast", async () => {
  await h.seedBroker("owner");
  // The seed skips the row triggers (search text and the like) to stay fast; plans do not depend on them.
  await h.pool.query("SET session_replication_role = replica");
  await h.pool.query(
    `INSERT INTO listings (code, agency_id, broker_id, title, property_type, listing_type, price_value, area_value, bedrooms, compound, status, details, confirmed_at)
     SELECT 'P' || g, CASE WHEN g % 10 = 0 THEN $2::uuid ELSE $1::uuid END, CASE WHEN g % 10 = 0 THEN $4::uuid ELSE $3::uuid END,
            'unit ' || g, 'apartment', 'sale', 1000000 + g, 100 + g % 200, 3, 'Compound ' || (g % 200), 'active', '{}'::jsonb, NOW() - (g || ' minutes')::interval
       FROM generate_series(1, 50000) g`,
    [h.AGENCY_A, h.AGENCY_B, h.BROKERS.broker.id, h.BROKERS.rival.id]
  );
  await h.pool.query("SET session_replication_role = DEFAULT");
  await h.pool.query("ANALYZE listings");

  const list = "SELECT id, code FROM listings WHERE agency_id = $1 AND status = 'active' ORDER BY confirmed_at DESC NULLS LAST, created_at DESC, id DESC LIMIT 20";
  const byCode = "SELECT id FROM listings WHERE agency_id = $1 AND lower(code) = lower($2)";
  const byCompound = "SELECT id FROM listings WHERE agency_id = $1 AND compound_key = $2";
  for (const [sql, args] of [[list, [h.AGENCY_A]], [byCode, [h.AGENCY_A, "p123"]], [byCompound, [h.AGENCY_A, "compound-5"]]]) {
    const p = await plan(sql, args);
    expect(p).not.toMatch(/Seq Scan on listings/);
  }

  const t0 = Date.now();
  for (let i = 0; i < 20; i++) await h.query(list, [h.AGENCY_A]);
  await h.query(byCode, [h.AGENCY_A, "p123"]);
  expect((Date.now() - t0) / 21).toBeLessThan(500);
});
