// services/areas.js — The shared list of areas and sub-zones: loading the starter list, linking compounds to their area from
// the old free-text district, and reading the approved list. Rules live in domain/areas.js.
"use strict";

const A = require("../domain/areas");

const COLUMNS = "id, parent_id, name_key, name_en, name_ar, aliases, lat, lng, status";

/** Approved areas and sub-zones (all levels). `db` is a client or the pool. */
async function approvedAreas(db) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM areas WHERE status = 'approved' ORDER BY name_en NULLS LAST, name_ar`);
  return rows;
}

/** Inserts the starter tree ({en, ar, aliases, lat, lng, children}) once; a node that already exists under its parent is left alone. */
async function seedTree(db, tree, parentId = null) {
  let added = 0;
  for (const node of tree) {
    const c = A.cleanArea({ name_en: node.en, name_ar: node.ar, aliases: node.aliases, lat: node.lat, lng: node.lng, parent_id: parentId });
    if (!c.ok) continue;
    const v = c.value;
    const found = await db.query("SELECT id FROM areas WHERE name_key = $1 AND parent_id IS NOT DISTINCT FROM $2", [v.name_key, parentId]);
    let id = found.rows[0]?.id;
    if (!id) {
      const ins = await db.query(
        `INSERT INTO areas (parent_id, name_key, name_en, name_ar, aliases, lat, lng, source) VALUES ($1, $2, $3, $4, $5, $6, $7, 'seed') RETURNING id`,
        [parentId, v.name_key, v.name_en, v.name_ar, v.aliases, v.lat, v.lng]
      );
      id = ins.rows[0].id;
      added += 1;
    }
    added += await seedTree(db, node.children || [], id);
  }
  return added;
}

/**
 * Sets area_id and subzone_id on compounds that have none, from the district text they already carry. Only a name that
 * leads to exactly one area counts; combined or unknown districts are left for the owner to fix.
 * @returns {{linked: number, left: number}}
 */
async function linkPlacesFromDistrict(db) {
  const areas = await approvedAreas(db);
  const index = A.buildIndex(areas);
  const { rows } = await db.query("SELECT id, district FROM map_places WHERE area_id IS NULL AND district IS NOT NULL AND district <> ''");
  let linked = 0;
  for (const p of rows) {
    const hit = A.resolveArea(index, p.district);
    if (!hit?.id) continue;
    const at = A.placement(areas, hit.id);
    await db.query("UPDATE map_places SET area_id = $2, subzone_id = $3 WHERE id = $1", [p.id, at.area_id, at.subzone_id]);
    linked += 1;
  }
  const left = await db.query("SELECT count(*)::int AS n FROM map_places WHERE area_id IS NULL");
  return { linked, left: left.rows[0].n };
}

/** Compounds with no area yet, for the owner to fix. */
async function placesWithoutArea(db, limit = 300) {
  const { rows } = await db.query(
    "SELECT id, name_en, name_ar, district FROM map_places WHERE area_id IS NULL ORDER BY name_en NULLS LAST, name_ar LIMIT $1",
    [limit]
  );
  return rows;
}

module.exports = { approvedAreas, seedTree, linkPlacesFromDistrict, placesWithoutArea };
