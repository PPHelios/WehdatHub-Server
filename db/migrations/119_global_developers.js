// 119: a global developer directory (names only), so every agency picks the same clean developer name. Nothing private is shared:
// an agency's developer row (contact, notes, warnings, terms) stays its own and only remembers which global name it is
// (developers.global_id). Seeded from the developers named in the v6 location list. Safe to run again.
// Roll back: ALTER TABLE developers DROP COLUMN global_id; DROP TABLE global_developers;
"use strict";

const fs = require("fs");
const path = require("path");

const SKIP = /^(private developer|unknown|n\/a|none|-)$/i;

async function up(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS global_developers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    name_en text CHECK (name_en IS NULL OR length(name_en) <= 120),
    verified boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await client.query("CREATE UNIQUE INDEX IF NOT EXISTS uq_global_developers_name ON global_developers (lower(btrim(name)))");
  await client.query("ALTER TABLE global_developers ENABLE ROW LEVEL SECURITY");
  await client.query("ALTER TABLE developers ADD COLUMN IF NOT EXISTS global_id uuid REFERENCES global_developers(id) ON DELETE SET NULL");
  await client.query("CREATE INDEX IF NOT EXISTS idx_developers_global ON developers (global_id) WHERE global_id IS NOT NULL");
  const file = path.join(__dirname, "..", "data", "location-v6-2026-11-15.json");
  if (!fs.existsSync(file)) return;
  const names = new Set(JSON.parse(fs.readFileSync(file, "utf8")).compounds.map((c) => String(c.developer || "").replace(/\s+/g, " ").trim()).filter((n) => n && !SKIP.test(n)));
  for (const n of names) {
    await client.query("INSERT INTO global_developers (name, name_en) VALUES ($1, $1) ON CONFLICT DO NOTHING", [n.slice(0, 120)]);
  }
}

module.exports = { up };
