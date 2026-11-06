// tests/unit/twin-villa-migration.test.js — Migration 081: a twinhouse unit becomes a twin villa, the search vocabulary
// is reseeded with the newer type words, and the twinhouse type is gone from the search vocabulary.
"use strict";

const { createTestDb } = require("../harness/db");
const Migration = require("../../db/migrations/081_twin_villa_types");

jest.setTimeout(60000);

let db;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.pool.end());

test("a twinhouse unit becomes a twin villa; the vocabulary has the new types and no twinhouse type", async () => {
  const { rows: [a] } = await db.pool.query("INSERT INTO agencies (name) VALUES ('Twin Agency') RETURNING id");
  const { rows: [b] } = await db.pool.query("INSERT INTO brokers (agency_id, phone_number, name, role, is_active) VALUES ($1, '201000000099', 'T', 'broker', true) RETURNING id", [a.id]);
  await db.pool.query("INSERT INTO listings (agency_id, broker_id, code, property_type, listing_type, status) VALUES ($1, $2, 'TW-1', 'twinhouse', 'sale', 'active')", [a.id, b.id]);
  await Migration.up(db.pool);
  const { rows: [unit] } = await db.pool.query("SELECT property_type FROM listings WHERE code = 'TW-1'");
  expect(unit.property_type).toBe("twin_villa");
  const { rows: types } = await db.pool.query("SELECT key FROM search_vocabulary WHERE kind = 'type'");
  const keys = types.map((r) => r.key);
  expect(keys).toEqual(expect.arrayContaining(["triplex", "triplex_roof", "sky_loft", "basement", "mazonette", "i_villa", "twin_villa", "maisonette"]));
  expect(keys).not.toContain("twinhouse");
});
