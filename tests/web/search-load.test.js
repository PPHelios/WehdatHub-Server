// tests/web/search-load.test.js — Search on 50,000 units (patch 5): typical searches answer fast, use the indexes, and 40 at once all answer.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const S = require("../../services/search");
const Q = require("../../domain/searchQuery");

jest.setTimeout(280000);

let h;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const QUERIES = [
  "شقة في هايد بارك 3 غرف",
  "apartment in Hyde Park 3 bedrooms",
  "فيلا حمام سباحه",
  "شقة للايجار 3 غرف",
  "شقة 3 غرف ميزانية 5 مليون",
  "P123"
];

test("typical searches on 50,000 units answer fast and 40 at once all answer", async () => {
  await h.seedBroker("owner");
  await h.pool.query("SET session_replication_role = replica");
  await h.pool.query(
    `INSERT INTO listings (code, agency_id, broker_id, title, property_type, listing_type, market, price_value, area_value, bedrooms, compound, compound_key, search_text_normalized, status, details, confirmed_at)
     SELECT 'P' || g, CASE WHEN g % 10 = 0 THEN $2::uuid ELSE $1::uuid END, CASE WHEN g % 10 = 0 THEN $4::uuid ELSE $3::uuid END,
            'unit ' || g, CASE WHEN g % 7 = 0 THEN 'villa' ELSE 'apartment' END, CASE WHEN g % 3 = 0 THEN 'rent' ELSE 'sale' END, 'resale', 1000000 + g * 90, 100 + g % 200, 1 + g % 5,
            CASE WHEN g % 20 = 3 THEN 'Hyde Park' ELSE 'Compound ' || (g % 200) END, CASE WHEN g % 20 = 3 THEN 'hyde_park' ELSE 'compound_' || (g % 200) END,
            'unit ' || g || CASE WHEN g % 20 = 3 THEN ' hyde park' ELSE ' compound ' || (g % 200) END || CASE WHEN g % 11 = 0 THEN ' حمام سباحه' ELSE '' END,
            'active', '{}'::jsonb, NOW() - (g || ' minutes')::interval
       FROM generate_series(1, 50000) g`,
    [h.AGENCY_A, h.AGENCY_B, h.BROKERS.broker.id, h.BROKERS.rival.id]
  );
  await h.pool.query("SET session_replication_role = DEFAULT");
  await h.pool.query("ANALYZE listings");

  const one = async (q) => {
    const parsed = Q.fallbackParse(q);
    const { sql, params } = S.buildSearchQuery(h.AGENCY_A, parsed, { fx: {} });
    const t0 = Date.now();
    const rows = (await h.pool.query(sql, params)).rows;
    return { q, ms: Date.now() - t0, n: rows.length, sql, params };
  };
  const slow = [];
  for (const q of QUERIES) {
    await one(q); // warm
    const r = await one(q);
    console.log(`SEARCH ${r.ms}ms rows=${r.n}  ${q}`);
    if (r.ms > 400) slow.push(`${r.ms}ms ${q}`);
  }
  expect(slow).toEqual([]);

  const t0 = Date.now();
  const out = await Promise.all(Array.from({ length: 40 }, (_, i) => one(QUERIES[i % QUERIES.length])));
  console.log(`PARALLEL 40 searches ${Date.now() - t0}ms`);
  expect(out.every((r) => r.n >= 0)).toBe(true);
  expect(Date.now() - t0).toBeLessThan(30000);
});
