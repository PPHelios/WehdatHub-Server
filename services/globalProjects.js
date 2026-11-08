// services/globalProjects.js — The global project library: the CRM owner publishes projects (facts only); an agency
// manager copies one into the agency's own projects. A copy is the agency's to edit; nothing is shared live.
"use strict";

const fs = require("fs");
const path = require("path");
const { isManager, isCrmOwner } = require("../lib/authz");

const PAGE_SIZE = 20;
const SUGGEST = 8;
const MAX = { name: 120, developer: 120, region: 120, status: 60, unit_types: 300, facts: 2000 };
const escapeLike = (t) => t.replace(/[\\%_]/g, (c) => `\\${c}`);

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

/** The fields the CRM owner types. Publishing is not in here: an edit never publishes. */
function fieldsOf(input = {}) {
  const v = {};
  for (const [k, max] of Object.entries(MAX)) {
    const t = String(input[k] ?? "").replace(/\s+/g, " ").trim();
    if (k === "name" && !t) return { error: "empty" };
    if (t.length > max) return { error: "too_long" };
    v[k] = t || null;
  }
  const acres = String(input.area_acres ?? "").trim();
  if (acres && !(Number(acres) >= 0)) return { error: "area" };
  v.area_acres = acres ? Number(acres) : null;
  return { fields: v };
}

/** Adds an entry to the library as an unpublished draft. CRM owner only. */
async function create(pool, actor, input = {}) {
  if (!isCrmOwner(actor)) return { error: "forbidden" };
  const r = fieldsOf(input);
  if (r.error) return r;
  const f = r.fields;
  try {
    const { rows } = await pool.query(
      `INSERT INTO global_projects (name, developer, region, status, unit_types, area_acres, facts)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [f.name, f.developer, f.region, f.status, f.unit_types, f.area_acres, f.facts]
    );
    return { ok: true, id: rows[0].id };
  } catch (e) {
    if (e.code === "23505") return { error: "duplicate" };
    throw e;
  }
}

/** Edits an entry. Never changes whether it is published. CRM owner only. */
async function update(pool, actor, id, input = {}) {
  if (!isCrmOwner(actor)) return { error: "forbidden" };
  if (!isId(id)) return { error: "not_found" };
  const r = fieldsOf(input);
  if (r.error) return r;
  const f = r.fields;
  try {
    const { rowCount } = await pool.query(
      `UPDATE global_projects SET name = $2, developer = $3, region = $4, status = $5, unit_types = $6, area_acres = $7, facts = $8, updated_at = now()
        WHERE id = $1`,
      [id, f.name, f.developer, f.region, f.status, f.unit_types, f.area_acres, f.facts]
    );
    return rowCount ? { ok: true } : { error: "not_found" };
  } catch (e) {
    if (e.code === "23505") return { error: "duplicate" };
    throw e;
  }
}

/**
 * One page of the library, optionally searched. The CRM owner sees every entry; agencies see published ones.
 * Suggestions are the names that match the search (up to 8), for the search box.
 * @returns {Promise<{items, total, page, pages, suggestions}>}
 */
async function listPage(pool, { agencyId = null, q = "", page = 1 } = {}) {
  const term = String(q || "").trim().toLowerCase().slice(0, 80);
  const pattern = term ? `%${escapeLike(term)}%` : null;
  const p = Math.max(1, Number.parseInt(page, 10) || 1);
  const where = `($1::uuid IS NULL OR g.published) AND ($2::text IS NULL OR lower(g.name) LIKE $2 OR lower(coalesce(g.developer, '')) LIKE $2 OR lower(coalesce(g.region, '')) LIKE $2 OR lower(coalesce(g.unit_types, '')) LIKE $2)`;
  const args = [agencyId, pattern];
  const count = await pool.query(`SELECT count(*)::int AS n FROM global_projects g WHERE ${where}`, args);
  const total = count.rows[0].n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(p, pages);
  const { rows } = await pool.query(
    `SELECT g.*, ($1::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM projects pr WHERE pr.agency_id = $1 AND pr.global_id = g.id)) AS used
       FROM global_projects g WHERE ${where} ORDER BY lower(g.name) LIMIT ${PAGE_SIZE} OFFSET ${(current - 1) * PAGE_SIZE}`,
    args
  );
  const suggestions = pattern
    ? (await pool.query(`SELECT g.name FROM global_projects g WHERE ${where} ORDER BY lower(g.name) LIMIT ${SUGGEST}`, args)).rows.map((r) => r.name)
    : [];
  return { items: rows, total, page: current, pages, suggestions };
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

/** One entry for the edit page (the CRM owner sees any; agencies see only published ones). */
async function getOne(pool, actor, id) {
  if (!isId(id)) return null;
  const { rows } = await pool.query("SELECT * FROM global_projects WHERE id = $1", [id]);
  const g = rows[0];
  if (!g) return null;
  return isCrmOwner(actor) || g.published ? g : null;
}

module.exports = { syncFile, list, listPage, create, update, getOne, setPublished, use, PAGE_SIZE };
