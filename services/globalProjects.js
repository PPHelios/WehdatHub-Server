// services/globalProjects.js — The global project library: the CRM owner publishes projects (facts only); an agency
// manager copies one into the agency's own projects. A copy is the agency's to edit; nothing is shared live.
"use strict";

const fs = require("fs");
const path = require("path");
const { isManager } = require("../lib/authz");

const isId = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ""));

/** Adds the projects of data/global-projects.json that are not there yet, as drafts. Safe to repeat. */
async function syncFile(pool, file = path.join(__dirname, "..", "data", "global-projects.json")) {
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  let added = 0;
  for (const r of rows) {
    const { rowCount } = await pool.query(
      `INSERT INTO global_projects (name, developer, region, status, unit_types, area_acres, facts)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (lower(btrim(name))) DO NOTHING`,
      [r.name, r.developer, r.region, r.status, r.unit_types, r.area_acres, r.facts]
    );
    added += rowCount;
  }
  return { added };
}

/** The owner sees all; agencies see published ones, each marked when the agency already has a copy. */
async function list(pool, { agencyId = null } = {}) {
  const { rows } = await pool.query(
    `SELECT g.*, ($1::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM projects p WHERE p.agency_id = $1 AND p.global_id = g.id)) AS used
       FROM global_projects g WHERE ($1::uuid IS NULL OR g.published) ORDER BY lower(g.name)`,
    [agencyId]
  );
  return rows;
}

async function setPublished(pool, id, published) {
  if (!isId(id)) return false;
  const { rowCount } = await pool.query("UPDATE global_projects SET published = $2, updated_at = now() WHERE id = $1", [id, Boolean(published)]);
  return rowCount > 0;
}

/** Copies a published project into the manager's agency. @returns {{ok: true, project: object}|{error: string}} */
async function use(pool, actor, id) {
  if (!isManager(actor)) return { error: "forbidden" };
  if (!isId(id)) return { error: "not_found" };
  const { rows } = await pool.query("SELECT * FROM global_projects WHERE id = $1 AND published", [id]);
  const g = rows[0];
  if (!g) return { error: "not_found" };
  const notes = [g.unit_types && `Unit types: ${g.unit_types}`, g.area_acres && `Area: ${g.area_acres} acres`, g.facts].filter(Boolean).join("\n");
  try {
    const ins = await pool.query(
      `INSERT INTO projects (agency_id, name, name_en, developer_name, district, status, notes, global_id)
       VALUES ($1, $2, $2, $3, $4, 'selling', $5, $6) RETURNING *`,
      [actor.agency_id, g.name, g.developer, g.region, notes || null, g.id]
    );
    return { ok: true, project: ins.rows[0] };
  } catch (e) {
    if (e.code === "23505") return { error: "duplicate" };
    throw e;
  }
}

module.exports = { syncFile, list, setPublished, use };
