// tests/heavy/restore-drill.test.js — Restore drill (patch 6): the whole database is copied out as a backup file and loaded into an empty
// database; every table has the same rows, the audit log is still protected, and the app's tables answer. (Supabase Free keeps no
// downloadable backup, so this proves the data can be moved and restored from a copy we make ourselves.)
"use strict";

const { createTestDb } = require("../harness/db");
const crypto = require("crypto");

jest.setTimeout(280000);

test("a backup copy restores into an empty database with the same rows and the audit protection", async () => {
  const { PGlite } = require("@electric-sql/pglite");
  const { pg_trgm } = require("@electric-sql/pglite/contrib/pg_trgm");
  const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");
  const { uuid_ossp } = require("@electric-sql/pglite/contrib/uuid_ossp");
  const { pool, db } = await createTestDb({ snapshot: false });
  const agency = crypto.randomUUID();
  await pool.query("INSERT INTO agencies (id, name, slug, phone, pilot) VALUES ($1, 'Drill', 'drill', '0220000000', true)", [agency]);
  await pool.query("INSERT INTO listings (code, agency_id, title, property_type, listing_type, status, details) SELECT 'D' || g, $1, 'unit', 'apartment', 'sale', 'active', '{}'::jsonb FROM generate_series(1, 2000) g", [agency]);
  await pool.query("INSERT INTO audit_logs (agency_id, action, payload) VALUES ($1, 'drill_event', '{}'::jsonb)", [agency]);

  const tables = (await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1")).rows.map((r) => r.table_name);
  const countsOf = async (p) => {
    const out = {};
    for (const t of tables) out[t] = (await p.query(`SELECT count(*)::int AS n FROM "${t}"`)).rows[0].n;
    return out;
  };
  const before = await countsOf(pool);

  const backup = await db.dumpDataDir("gzip");
  const restored = new PGlite({ loadDataDir: backup, extensions: { pg_trgm, pgcrypto, uuid_ossp } });
  await restored.waitReady;
  const after = {};
  for (const t of tables) after[t] = (await restored.query(`SELECT count(*)::int AS n FROM "${t}"`)).rows[0].n;
  expect(after).toEqual(before);
  expect(before.listings).toBe(2000);

  // The restored copy still answers a real query and still refuses to edit the audit log.
  expect((await restored.query("SELECT count(*)::int AS n FROM listings WHERE agency_id = $1 AND status = 'active'", [agency])).rows[0].n).toBe(2000);
  await expect(restored.query("UPDATE audit_logs SET action = 'changed' WHERE action = 'drill_event'")).rejects.toThrow();
  await restored.close();
});
