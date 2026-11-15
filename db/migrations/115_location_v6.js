// 115: loads the v6 location list (db/data/location-v6-2026-11-15.json, from the 2026-11-15 workbook): area pins fixed, compounds
// moved to their sub-area, pins, aliases, developers and the "also in" zones (place_zones). Decisions are in
// docs/plans/unified-unit-box.md section 8. Safe to re-run: every step finds what is already there, a failing row is skipped
// (logged) and never stops the rest. Backups of areas, compounds and unit locations are kept in *_backup_115 tables.
"use strict";

const data = require("../data/location-v6-2026-11-15.json");
const { placeKey } = require("../../domain/mapPlaces");

// An alias with letters that are neither Arabic nor Latin is a broken copy (one old name had Korean letters in it).
const READABLE = /^[\p{Script=Arabic}\p{Script=Latin}\p{N}\p{P}\p{Zs}\p{S}]+$/u;
const uniq = (list) => {
  const seen = new Set();
  return list.filter((a) => {
    const k = placeKey(a);
    if (!a || !k || /^[?\s]+$/.test(a) || !READABLE.test(a) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

async function up(client) {
  const skipped = [];
  const kept = [];
  let n = 0;
  async function guarded(label, fn) {
    const sp = `s${n++}`;
    await client.query(`SAVEPOINT ${sp}`);
    try {
      await fn();
      await client.query(`RELEASE SAVEPOINT ${sp}`);
    } catch (e) {
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      skipped.push(`${label}: ${e.message}`);
    }
  }

  for (const t of ["areas", "map_places"]) {
    await client.query(`CREATE TABLE IF NOT EXISTS ${t}_backup_115 AS SELECT * FROM ${t}`);
    await client.query(`ALTER TABLE ${t}_backup_115 ENABLE ROW LEVEL SECURITY`);
  }
  await client.query("CREATE TABLE IF NOT EXISTS listings_location_backup_115 AS SELECT id, area_id, subzone_id, place_id FROM listings");
  await client.query("ALTER TABLE listings_location_backup_115 ENABLE ROW LEVEL SECURITY");

  // ---- area tree: new rows added, the four "trap" pins replaced, empty facts filled ----
  const ids = new Map(); // path -> area id
  const find = async (parentId, name) =>
    (await client.query("SELECT id FROM areas WHERE name_key = $1 AND parent_id IS NOT DISTINCT FROM $2", [placeKey(name), parentId])).rows[0]?.id || null;
  async function walk(path) {
    let id = null;
    for (const seg of path.split(" > ")) {
      id = await find(id, seg);
      if (!id) return null;
    }
    return id;
  }
  for (const t of data.tree) {
    await guarded(`area ${t.path}`, async () => {
      const segs = t.path.split(" > ");
      const parentId = segs.length > 1 ? ids.get(segs.slice(0, -1).join(" > ")) : null;
      if (segs.length > 1 && !parentId) throw new Error("parent missing");
      let id = await find(parentId, t.name_en);
      if (id) {
        await client.query(
          `UPDATE areas SET place_type = COALESCE(place_type, $2), governorate = COALESCE(governorate, $3), google_place_id = COALESCE(google_place_id, $4),
             name_ar = COALESCE(name_ar, $5),
             lat = CASE WHEN $8 AND $6::float8 IS NOT NULL THEN $6 ELSE COALESCE(lat, $6) END,
             lng = CASE WHEN $8 AND $7::float8 IS NOT NULL THEN $7 ELSE COALESCE(lng, $7) END,
             updated_at = now() WHERE id = $1`,
          [id, t.place_type, t.governorate, t.google_place_id || null, t.name_ar || null, t.lat ?? null, t.lng ?? null, Boolean(t.fix_pin)]
        );
      } else {
        id = (
          await client.query(
            `INSERT INTO areas (parent_id, name_key, name_en, name_ar, lat, lng, place_type, governorate, google_place_id, disambiguation_note, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'seed') RETURNING id`,
            [parentId, placeKey(t.name_en), t.name_en, t.name_ar || null, t.lat ?? null, t.lng ?? null, t.place_type, t.governorate, t.google_place_id || null, t.disambiguation || null]
          )
        ).rows[0].id;
      }
      ids.set(t.path, id);
    });
  }

  // ---- duplicates become aliases of the main area; compounds, units and children move across (also to another city) ----
  for (const m of data.merges) {
    await guarded(`merge ${m.from}`, async () => {
      const from = await walk(m.from);
      const into = ids.get(m.into);
      if (!into || !from || from === into) return;
      const intoTop = ids.get(m.into.split(" > ")[0]);
      const f = (await client.query("SELECT name_en, name_ar, aliases FROM areas WHERE id = $1", [from])).rows[0];
      const cur = (await client.query("SELECT aliases FROM areas WHERE id = $1", [into])).rows[0].aliases;
      await client.query("UPDATE areas SET parent_id = $2 WHERE parent_id = $1", [from, into]);
      await client.query("UPDATE map_places SET area_id = $3, subzone_id = $2 WHERE subzone_id = $1", [from, into, intoTop]);
      await client.query("UPDATE listings SET area_id = $3, subzone_id = $2 WHERE subzone_id = $1", [from, into, intoTop]);
      await client.query("UPDATE areas SET aliases = $2 WHERE id = $1", [into, uniq([...cur, f.name_en, f.name_ar, ...f.aliases]).slice(0, 20)]);
      await client.query("DELETE FROM areas WHERE id = $1", [from]);
    });
  }

  // ---- compounds ----
  const placement = (path) => {
    const segs = path.split(" > ");
    return { area_id: ids.get(segs[0]) || null, subzone_id: segs.length > 1 ? ids.get(path) || null : null };
  };
  const pinsAsOf = new Date(`${data.pins_as_of}T00:00:00Z`);
  const rowOf = new Map(); // v6 id -> the map_places row it is (another id where 111 inserted it fresh)
  for (const c of data.compounds) {
    await guarded(`compound ${c.name_en}`, async () => {
      const at = placement(c.path);
      if (!at.area_id) throw new Error(`no area for ${c.path}`);
      const oldNames = [c.old_name_en, c.old_name_ar].filter(Boolean);
      let row = (await client.query("SELECT id, aliases, name_key, lat, lng, pin_checked_at FROM map_places WHERE id = $1", [c.id])).rows[0];
      if (!row) row = (await client.query("SELECT id, aliases, name_key, lat, lng, pin_checked_at FROM map_places WHERE name_key = ANY($1)", [[placeKey(c.name_en), placeKey(c.old_name_en || c.name_en)]])).rows[0];
      if (!row) {
        const ins = await client.query(
          `INSERT INTO map_places (id, name_key, name_en, name_ar, developer, lat, lng, aliases, source, approved, verified, area_id, subzone_id,
             google_place_id, project_info_en, project_info_ar, project_info_source)
           VALUES ($15, $1, $2, $3, $4, $5, $6, $7, 'manual', true, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
          [placeKey(c.name_en), c.name_en, c.name_ar, c.developer, c.lat ?? null, c.lng ?? null, uniq([...c.aliases, ...oldNames]).slice(0, 20), c.verified, at.area_id, at.subzone_id, c.google_place_id, c.info_en || null, c.info_ar || null, c.info_source || null, c.id]
        );
        rowOf.set(c.id, ins.rows[0].id);
        return;
      }
      rowOf.set(c.id, row.id);
      // v6 removed some aliases on purpose (one compound's name on another); aliases the owner added since are kept.
      const dropped = new Set((c.dropped_aliases || []).map(placeKey));
      const aliases = uniq([...c.aliases, ...oldNames, ...row.aliases.filter((a) => !dropped.has(placeKey(a)))]).slice(0, 20);
      // A pin the owner confirmed in the pin review after the workbook's date stays.
      const ownerPin = row.pin_checked_at && new Date(row.pin_checked_at) > pinsAsOf;
      const moved = c.lat != null && (Math.abs((row.lat ?? 0) - c.lat) > 1e-5 || Math.abs((row.lng ?? 0) - c.lng) > 1e-5);
      if (ownerPin && moved) kept.push(c.name_en);
      const pin = ownerPin || c.lat == null ? [row.lat, row.lng] : [c.lat, c.lng];
      await client.query(
        `UPDATE map_places SET name_en = $2, name_ar = $3, aliases = $4, area_id = $5, subzone_id = $6, lat = $7, lng = $8,
           google_place_id = COALESCE($9, google_place_id), developer = COALESCE($10, developer), verified = $11,
           project_info_en = COALESCE($12, project_info_en), project_info_ar = COALESCE($13, project_info_ar),
           project_info_source = COALESCE($14, project_info_source), updated_at = now() WHERE id = $1`,
        [row.id, c.name_en, c.name_ar, aliases, at.area_id, at.subzone_id, pin[0], pin[1], c.google_place_id, c.developer, c.verified, c.info_en || null, c.info_ar || null, c.info_source || null]
      );
      const key = placeKey(c.name_en);
      if (key !== row.name_key) await guarded(`rename ${c.name_en}`, () => client.query("UPDATE map_places SET name_key = $2 WHERE id = $1", [row.id, key]));
    });
  }

  // ---- zones ("also in") ----
  for (const c of data.compounds) {
    for (const z of c.zones || []) {
      await guarded(`zone ${c.name_en} → ${z}`, async () => {
        const areaId = ids.get(z);
        if (!areaId) throw new Error("zone area missing");
        if (!rowOf.has(c.id)) throw new Error("compound not loaded");
        await client.query("INSERT INTO place_zones (place_id, area_id, source) VALUES ($1, $2, 'seed') ON CONFLICT DO NOTHING", [rowOf.get(c.id), areaId]);
      });
    }
  }

  // ---- units follow their compound's area and sub-zone ----
  await client.query(
    `UPDATE listings l SET area_id = p.area_id, subzone_id = p.subzone_id
       FROM map_places p
      WHERE l.place_id = p.id AND p.area_id IS NOT NULL
        AND (l.area_id IS DISTINCT FROM p.area_id OR l.subzone_id IS DISTINCT FROM p.subzone_id)`
  );
  if (kept.length) console.warn(`[115_location_v6] ${kept.length} owner-checked pins kept (v6 differs): ${kept.join(", ")}`);
  if (skipped.length) console.warn(`[115_location_v6] ${skipped.length} skipped:\n${skipped.join("\n")}`);
}

module.exports = { up };
