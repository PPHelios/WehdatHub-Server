// 141: compound phases (Madinaty B1…B15, El Rehab phases 1…10) as sub-zones of the areas tree. The list is data/areas/compound-phases.json
// (a draft the owner will change: edit the file and load it with a later migration). A phase is an `areas` row with place_type
// 'phase' under the compound's area or sub-zone; the unit box offers a compound's phases as chips and the unit keeps the phase in
// listings.subzone_id. Existing rows (Madinaty "B6", "El Rehab", loaded by 111/115) are reused by name_key under their parent, renamed
// to the file's names (the old names become aliases; name_key stays, so re-running 111/115 still finds them), never duplicated. Compounds without an area are linked to the parent.
// Safe to re-run. Backup of areas and map_places locations: *_backup_141.
"use strict";

const data = require("../../data/areas/compound-phases.json");
const { placeKey } = require("../../domain/mapPlaces");

const uniq = (list, limit = 24) => {
  const seen = new Set();
  return list
    .filter((a) => {
      const k = placeKey(a);
      if (!a || !k || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, limit);
};

async function up(client) {
  // The phase type is new: widen the check (the list is also in SCHEMA_REFERENCE.sql).
  await client.query("ALTER TABLE areas DROP CONSTRAINT IF EXISTS areas_place_type_check");
  await client.query(
    "ALTER TABLE areas ADD CONSTRAINT areas_place_type_check CHECK (place_type IS NULL OR place_type = ANY (ARRAY['city_or_district','sub_area_or_sector','neighborhood_or_zone','road_or_corridor','phase']))"
  );
  await client.query("CREATE TABLE IF NOT EXISTS areas_backup_141 AS SELECT * FROM areas");
  await client.query("ALTER TABLE areas_backup_141 ENABLE ROW LEVEL SECURITY");
  await client.query("CREATE TABLE IF NOT EXISTS map_places_location_backup_141 AS SELECT id, area_id, subzone_id FROM map_places");
  await client.query("ALTER TABLE map_places_location_backup_141 ENABLE ROW LEVEL SECURITY");

  const keysOf = (n) => uniq([n.en, n.ar, ...(n.aliases || [])].filter(Boolean)).map(placeKey);
  const nodeIds = []; // parent nodes of the file, for linking compounds: { id, topId, subId, keys }

  // A node: found under its parent by any of its keys, else added. A phase is renamed to the file's names; a parent keeps its own.
  async function place(node, parent, asPhase) {
    const parentId = parent ? parent.id : null;
    const keys = keysOf(node);
    const found = (await client.query("SELECT id, name_en, name_ar, aliases FROM areas WHERE parent_id IS NOT DISTINCT FROM $1 AND name_key = ANY($2) ORDER BY (name_key = $3) DESC LIMIT 1", [parentId, keys, placeKey(node.en)])).rows[0];
    let id;
    if (found) {
      id = found.id;
      const aliases = uniq([...found.aliases, ...(node.aliases || []), ...(asPhase ? [found.name_en, found.name_ar] : [])].filter(Boolean));
      if (asPhase) {
        await client.query(
          `UPDATE areas SET name_en = $2, name_ar = $3, aliases = $4, place_type = 'phase',
             lat = COALESCE(lat, $5), lng = COALESCE(lng, $6), updated_at = now() WHERE id = $1`,
          [id, node.en, node.ar, aliases, node.lat ?? null, node.lng ?? null]
        );
      } else {
        await client.query("UPDATE areas SET aliases = $2, name_ar = COALESCE(name_ar, $3), lat = COALESCE(lat, $4), lng = COALESCE(lng, $5), updated_at = now() WHERE id = $1", [id, aliases, node.ar, node.lat ?? null, node.lng ?? null]);
      }
    } else {
      id = (
        await client.query(
          `INSERT INTO areas (parent_id, name_key, name_en, name_ar, aliases, lat, lng, place_type, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'seed') RETURNING id`,
          [parentId, placeKey(node.en), node.en, node.ar, uniq(node.aliases || []), node.lat ?? null, node.lng ?? null, asPhase ? "phase" : null]
        )
      ).rows[0].id;
    }
    return { id, topId: parent ? parent.topId : id, subId: parent ? id : null };
  }

  async function walk(nodes, parent) {
    for (const node of nodes) {
      const me = await place(node, parent, false);
      if (node.children_are_phases) {
        nodeIds.push({ ...me, keys: keysOf(node) });
        for (const ph of node.children || []) await place(ph, me, true);
      } else await walk(node.children || [], me);
    }
  }
  // A phase node is placed with asPhase; its parents are plain nodes.
  await walk(data.tree, null);

  // Compounds that carry the parent's name and have no area yet: picking the compound offers its phases.
  for (const p of nodeIds) {
    const compounds = (await client.query("SELECT id, name_key, aliases FROM map_places WHERE area_id IS NULL")).rows;
    for (const c of compounds) {
      if (![c.name_key, ...c.aliases.map(placeKey)].some((k) => p.keys.includes(k))) continue;
      await client.query("UPDATE map_places SET area_id = $2, subzone_id = $3, updated_at = now() WHERE id = $1 AND area_id IS NULL", [c.id, p.topId, p.subId]);
    }
  }
}

module.exports = { up };
