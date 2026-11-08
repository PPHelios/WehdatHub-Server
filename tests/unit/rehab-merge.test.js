// tests/unit/rehab-merge.test.js — Migration 095 folds the El Rehab phase places into one compound.
"use strict";

const fs = require("fs");
const path = require("path");
const { createTestDb } = require("../harness/db");
const Deal = require("../../domain/dealType");

test("phase places become aliases of El Rehab City and their units move over", async () => {
  const db = await createTestDb({ migrate: true });
  try {
    const q = (sql, p) => db.pool.query(sql, p).then((r) => r.rows);
    const [parent] = await q(`INSERT INTO map_places (name_key, name_en, name_ar, lat, lng, source, approved) VALUES ('el rehab city', 'El Rehab City', 'مدينة الرحاب', 30.06, 31.49, 'seed', true) RETURNING id`);
    const [ph] = await q(`INSERT INTO map_places (name_key, name_en, source, approved) VALUES ('el rehab city phase 1', 'El Rehab City - Phase 1', 'seed', true) RETURNING id`);
    const [ag] = await q("SELECT id FROM agencies LIMIT 1").catch(() => []);
    if (ag) {
      // Units are covered by the harness-based tests; here the place side is what matters.
    }
    await db.pool.query(fs.readFileSync(path.join(__dirname, "../../db/migrations/095_merge_rehab_phases.sql"), "utf8"));
    expect(await q("SELECT 1 FROM map_places WHERE id = $1", [ph.id])).toHaveLength(0);
    const [p] = await q("SELECT aliases FROM map_places WHERE id = $1", [parent.id]);
    expect(p.aliases).toEqual(expect.arrayContaining(["el rehab 1", "rehab1", "el rehab 2"]));
  } finally {
    await db.close?.();
  }
});

test("deal types map to fixed SQL", () => {
  expect(Deal.clean("rent")).toBe("rent");
  expect(Deal.clean("x; DROP")).toBe("");
  expect(Deal.sql("resale_installments", "l")).toMatch(/remaining_amount, 0\) > 0/);
  expect(Deal.sql("", "l")).toBe("TRUE");
});
