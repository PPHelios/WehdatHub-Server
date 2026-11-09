// services/mapPlaces.js — The map: places (owner-edited, global) and the pins an agency sees (its own visible active units
// grouped by the place their compound belongs to). The unit read goes through lib/visibility like every other read.
"use strict";

const Vis = require("../lib/visibility");
const P = require("../domain/mapPlaces");
const Describe = require("../domain/describe");

const CACHE_MS = 60 * 1000;
let cache = { at: 0, places: [], index: new Map() };

/** All places, cached for a minute (the owner's own changes clear it). */
async function allPlaces(pool) {
  if (Date.now() - cache.at < CACHE_MS) return cache;
  const { rows } = await pool.query("SELECT id, name_en, name_ar, developer, district, lat, lng, aliases, verified, approved FROM map_places");
  cache = { at: Date.now(), places: rows, index: P.buildIndex(rows) };
  return cache;
}
const clearCache = () => {
  cache = { at: 0, places: [], index: new Map() };
  require("./placeSuggest").resetCache();
};

const TYPES = ["sale", "rent"];
const FINISHING = Object.keys(Describe.FINISHING_LABELS);
const FURNISHING = Object.keys(Describe.FURNISHING_LABELS);
const Deal = require("../domain/dealType");
const num = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/** Filters read from a query string; anything else is ignored. */
function cleanFilters(q = {}) {
  const rooms = num(q.rooms);
  return {
    type: TYPES.includes(q.type) ? q.type : null,
    rooms: rooms !== null && rooms >= 0 && rooms <= 20 ? Math.floor(rooms) : null,
    ptype: q.ptype ? String(q.ptype).slice(0, 40) : null,
    pmin: num(q.pmin) !== null && num(q.pmin) >= 0 ? num(q.pmin) : null,
    pmax: num(q.pmax) !== null && num(q.pmax) > 0 ? num(q.pmax) : null,
    fin: FINISHING.includes(q.fin) || q.fin === "none" ? q.fin : null,
    furn: FURNISHING.includes(q.furn) || q.furn === "none" ? q.furn : null,
    deal: Deal.clean(q.deal) || null
  };
}

// 5 means "5 or more"; the other numbers are exact.
const ROOMS_SQL = "($3::int IS NULL OR ($3::int < 5 AND l.bedrooms = $3::int) OR ($3::int >= 5 AND l.bedrooms >= 5))";
const FILTER_SQL = `l.agency_id = $1 AND l.status = 'active'
     AND ($2::text IS NULL OR l.listing_type = $2)
     AND ${ROOMS_SQL}
     AND ($4::text IS NULL OR l.property_type = $4)
     AND ($5::numeric IS NULL OR l.price_value >= $5)
     AND ($6::numeric IS NULL OR l.price_value <= $6)
     AND ($7::text IS NULL OR l.finishing = $7 OR ($7 = 'none' AND l.finishing IS NULL))
     AND ($8::text IS NULL OR l.furnishing = $8 OR ($8 = 'none' AND l.furnishing IS NULL))
     AND ($9::text IS NULL OR CASE $9
          WHEN 'rent' THEN l.listing_type = 'rent'
          WHEN 'resale_cash' THEN (l.listing_type = 'sale' AND l.market = 'resale' AND coalesce(l.remaining_amount, 0) = 0)
          WHEN 'resale_installments' THEN (l.listing_type = 'sale' AND l.market = 'resale' AND coalesce(l.remaining_amount, 0) > 0)
          WHEN 'primary' THEN l.market = 'primary'
          ELSE TRUE END)`;
const args = (agencyId, f) => [agencyId, f.type, f.rooms, f.ptype, f.pmin, f.pmax, f.fin, f.furn, f.deal];

/** The words the search box matches a place by: its own aliases plus the approved search words (search_aliases) that point to it. */
function termsFor(place, aliasRows = []) {
  const name = String(place.name_en || "").toLowerCase();
  const fromRows = aliasRows.filter((a) => String(a.target || "").toLowerCase() === name).map((a) => a.term);
  return [...(place.aliases || []), ...fromRows].filter(Boolean).join(" ");
}

/** Pins for a broker: one per place that has visible units under the filters, plus what the filter bar offers. */
async function pins(pool, broker, query = {}) {
  const f = cleanFilters(query);
  const { places, index } = await allPlaces(pool);
  const { rows: aliasRows } = await pool.query("SELECT term, target FROM search_aliases WHERE status = 'approved' AND kind = 'place'");
  const { rows } = await pool.query(
    `SELECT l.compound, l.compound_en, count(*)::int AS n
       FROM listings l
      WHERE ${FILTER_SQL} AND ${Vis.units("l")}
      GROUP BY l.compound, l.compound_en`,
    args(broker.agency_id, f)
  );
  const counts = new Map();
  let unmapped = 0;
  for (const r of rows) {
    const id = P.matchCompound(index, r.compound_en, r.compound);
    if (id && places.find((p) => p.id === id)?.lat == null) unmapped += r.n; // approved by name, no pin yet
    else if (id) counts.set(id, (counts.get(id) || 0) + r.n);
    else unmapped += r.n;
  }
  const byId = new Map(places.map((p) => [p.id, p]));
  const out = [...counts.entries()]
    .map(([id, n]) => ({ id, n, name: byId.get(id).name_en || byId.get(id).name_ar, name_ar: byId.get(id).name_ar, name_en: byId.get(id).name_en, developer: byId.get(id).developer, district: byId.get(id).district, lat: byId.get(id).lat, lng: byId.get(id).lng, terms: termsFor(byId.get(id), aliasRows) }))
    .sort((a, b) => b.n - a.n);
  // Approved places with a position but no visible units under the filters: not drawn, but found by the search box.
  const idle = places
    .filter((p) => p.approved && p.lat != null && !counts.has(p.id))
    .map((p) => ({ id: p.id, n: 0, name: p.name_en || p.name_ar, name_ar: p.name_ar, name_en: p.name_en, developer: p.developer, district: p.district, lat: p.lat, lng: p.lng, terms: termsFor(p, aliasRows) }));
  return { pins: out, idle, total: out.reduce((s, p) => s + p.n, 0), unmapped, filters: f };
}

/** What the filter bar offers: unit types, price range for the chosen sale/rent, and which room counts exist. */
async function facets(pool, broker, query = {}) {
  const type = TYPES.includes(query.type) ? query.type : null;
  const { rows } = await pool.query(
    `SELECT l.property_type, l.bedrooms, count(*)::int AS n, min(l.price_value) AS pmin, max(l.price_value) AS pmax
       FROM listings l
      WHERE l.agency_id = $1 AND l.status = 'active' AND ($2::text IS NULL OR l.listing_type = $2)
        AND l.price_value > 0 AND ${Vis.units("l")}
      GROUP BY l.property_type, l.bedrooms`,
    [broker.agency_id, type]
  );
  const types = new Map();
  const rooms = new Set();
  let pmin = null;
  let pmax = null;
  for (const r of rows) {
    if (r.property_type) types.set(r.property_type, (types.get(r.property_type) || 0) + r.n);
    if (r.bedrooms !== null && r.bedrooms !== undefined) rooms.add(Math.min(Number(r.bedrooms), 5));
    if (r.pmin !== null) pmin = pmin === null ? Number(r.pmin) : Math.min(pmin, Number(r.pmin));
    if (r.pmax !== null) pmax = pmax === null ? Number(r.pmax) : Math.max(pmax, Number(r.pmax));
  }
  return {
    types: [...types.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k),
    rooms: [...rooms].sort((a, b) => a - b),
    pmin,
    pmax
  };
}

/** Visible units of one place (the drawer), newest first. */
async function unitsAt(pool, broker, placeId, query = {}, limit = 40) {
  const f = cleanFilters(query);
  const { index } = await allPlaces(pool);
  const names = await pool.query(
    `SELECT l.compound, l.compound_en FROM listings l WHERE ${FILTER_SQL} AND ${Vis.units("l")} GROUP BY l.compound, l.compound_en`,
    args(broker.agency_id, f)
  );
  const compounds = new Set();
  const compoundsEn = new Set();
  for (const r of names.rows) {
    if (P.matchCompound(index, r.compound_en, r.compound) === placeId) {
      if (r.compound) compounds.add(r.compound);
      if (r.compound_en) compoundsEn.add(r.compound_en);
    }
  }
  if (!compounds.size && !compoundsEn.size) return [];
  const { rows } = await pool.query(
    `SELECT l.id, l.code, l.title, l.property_type, l.listing_type, l.bedrooms, l.bathrooms, l.area_value, l.price_value, l.price_display, l.compound, l.compound_en
       FROM listings l
      WHERE ${FILTER_SQL} AND ${Vis.units("l")} AND (l.compound = ANY($10::text[]) OR l.compound_en = ANY($11::text[]))
      ORDER BY l.created_at DESC
      LIMIT ${Math.min(Math.max(1, limit), 100)}`,
    [...args(broker.agency_id, f), [...compounds], [...compoundsEn]]
  );
  return rows;
}

/** A place typed by name (the owner's alias form): its key first, else the only name that contains the text. */
async function findByName(pool, text) {
  const key = P.placeKey(text);
  if (key.length < 2) return null;
  const exact = await pool.query("SELECT id FROM map_places WHERE name_key = $1", [key]);
  if (exact.rows[0]) return exact.rows[0].id;
  const like = await pool.query("SELECT id FROM map_places WHERE name_en ILIKE '%' || $1 || '%' OR name_ar ILIKE '%' || $1 || '%' LIMIT 2", [String(text).trim().slice(0, 80)]);
  return like.rows.length === 1 ? like.rows[0].id : null;
}

/** One place by id (the drawer title). */
async function place(pool, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) return null;
  const { rows } = await pool.query("SELECT * FROM map_places WHERE id = $1", [id]);
  return rows[0] || null;
}

// ---- The CRM owner's window ------------------------------------------------

/** Places for the owner's list: filtered by a name, newest edits first. */
async function list(pool, { q = "", verified = null, limit = 200, offset = 0 } = {}) {
  const text = String(q || "").trim().slice(0, 80);
  // Spaces and punctuation are ignored, both ways: "east town" finds "Eastown", and "Eastown compound" finds "Eastown" too.
  const key = text.toLowerCase().replace(/[\s\-_./,()&'"]+/g, "");
  const { rows } = await pool.query(
    `WITH p AS (
       SELECT *,
         regexp_replace(lower(coalesce(name_en, '')), '[[:space:]_./,()&''"-]+', '', 'g') AS en_k,
         regexp_replace(coalesce(name_ar, ''), '[[:space:]_./,()&''"-]+', '', 'g') AS ar_k,
         regexp_replace(lower(concat_ws(' ', name_en, name_ar, district, developer, array_to_string(aliases, ' '))), '[[:space:]_./,()&''"-]+', '', 'g') AS hay
       FROM map_places)
     SELECT * FROM p
      WHERE ($1 = '' OR hay LIKE '%' || $1 || '%' OR (length(en_k) >= 4 AND $1 LIKE '%' || en_k || '%') OR (length(ar_k) >= 3 AND $1 LIKE '%' || ar_k || '%'))
        AND ($2::boolean IS NULL OR verified = $2)
      ORDER BY verified DESC, updated_at DESC, name_en
      LIMIT $3 OFFSET $4`,
    [key, verified, Math.min(limit, 500), Math.max(0, offset)]
  );
  const total = await pool.query("SELECT count(*)::int AS n, count(*) FILTER (WHERE verified)::int AS ok FROM map_places");
  return { rows, total: total.rows[0].n, verified: total.rows[0].ok };
}

/** Adds or updates a place by its name key. Returns the saved row. */
async function save(pool, id, input) {
  const c = P.cleanPlace(input);
  if (!c.ok) return c;
  const v = c.value;
  // Every compound has an area; a sub-zone, if given, sits under it.
  const loc = require("../domain/areas").checkLocation({ area_id: input.area_id, subzone_id: input.subzone_id }, { kind: "compound", areas: await require("./areas").approvedAreas(pool) });
  if (!loc.ok) return { ok: false, error: loc.error };
  if (id) {
    try {
      const { rows } = await pool.query(
        `UPDATE map_places SET name_key=$2, name_en=$3, name_ar=$4, developer=$5, district=$6, lat=$7, lng=$8, aliases=$9, verified=$10, area_id=$11, subzone_id=$12, approved=true, updated_at=now() WHERE id=$1 RETURNING *`,
        [id, v.name_key, v.name_en, v.name_ar, v.developer, v.district, v.lat, v.lng, v.aliases, v.verified, loc.area_id, loc.subzone_id]
      );
      clearCache();
      return rows[0] ? { ok: true, place: rows[0] } : { ok: false, error: "missing" };
    } catch (e) {
      if (e.code === "23505") return { ok: false, error: "duplicate" };
      throw e;
    }
  }
  const { rows } = await pool.query(
    `INSERT INTO map_places (name_key, name_en, name_ar, developer, district, lat, lng, aliases, verified, source, approved, area_id, subzone_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual',true,$10,$11)
     ON CONFLICT (name_key) DO NOTHING RETURNING *`,
    [v.name_key, v.name_en, v.name_ar, v.developer, v.district, v.lat, v.lng, v.aliases, v.verified, loc.area_id, loc.subzone_id]
  );
  clearCache();
  return rows[0] ? { ok: true, place: rows[0] } : { ok: false, error: "duplicate" };
}

async function remove(pool, id) {
  const { rowCount } = await pool.query("DELETE FROM map_places WHERE id = $1", [id]);
  clearCache();
  return rowCount > 0;
}

/** Adds a name a unit uses to a place, so those units show on its pin. */
async function addAlias(pool, id, alias) {
  const a = String(alias || "").trim().slice(0, 80);
  if (a.length < 2) return false;
  const { rowCount } = await pool.query(
    "UPDATE map_places SET aliases = (SELECT array(SELECT DISTINCT unnest(aliases || ARRAY[$2]))), updated_at = now() WHERE id = $1",
    [id, a]
  );
  clearCache();
  return rowCount > 0;
}

/** Loads the seed rows; a place the owner already has (same name key) is left as it is. */
async function importSeed(pool, rows) {
  let added = 0;
  const clean = [];
  const seen = new Set();
  for (const r of rows) {
    const c = P.cleanPlace({ ...r, verified: false });
    if (!c.ok || !c.value.name_key || seen.has(c.value.name_key)) continue;
    seen.add(c.value.name_key);
    clean.push(c.value);
  }
  for (let i = 0; i < clean.length; i += 500) {
    const batch = clean.slice(i, i + 500);
    const { rowCount } = await pool.query(
      `INSERT INTO map_places (name_key, name_en, name_ar, developer, district, lat, lng, aliases, verified, source)
       SELECT x.name_key, x.name_en, x.name_ar, x.developer, x.district, x.lat, x.lng, '{}', false, 'seed'
         FROM jsonb_to_recordset($1::jsonb) AS x(name_key text, name_en text, name_ar text, developer text, district text, lat double precision, lng double precision)
       ON CONFLICT (name_key) DO NOTHING`,
      [JSON.stringify(batch)]
    );
    added += rowCount;
  }
  clearCache();
  return { read: rows.length, usable: clean.length, added };
}

/**
 * Loads the master list (names, Arabic names, developers, spellings): each place is approved. A place the map already
 * has keeps its position; one it does not have is added without one (its pin is dropped later).
 */
async function importMaster(pool, rows) {
  const all = await pool.query("SELECT id, name_key, name_en, name_ar, aliases, verified FROM map_places");
  const index = P.buildIndex(all.rows);
  let updated = 0;
  let added = 0;
  for (const r of rows) {
    const key = P.placeKey(r.name_en || r.name_ar);
    if (key.length < 2) continue;
    const id = index.get(key) || (r.aliases || []).map((a) => index.get(P.placeKey(a))).find(Boolean);
    const aliases = (r.aliases || []).filter(Boolean);
    if (id) {
      await pool.query(
        `UPDATE map_places SET approved = true, name_ar = COALESCE(name_ar, $2), developer = COALESCE(developer, $3), district = COALESCE(district, $4),
                aliases = (SELECT array(SELECT DISTINCT unnest(aliases || $5::text[]))), updated_at = now() WHERE id = $1`,
        [id, r.name_ar || null, r.developer || null, r.district || null, aliases]
      );
      updated += 1;
    } else {
      const { rowCount } = await pool.query(
        `INSERT INTO map_places (name_key, name_en, name_ar, developer, district, aliases, verified, source, approved) VALUES ($1,$2,$3,$4,$5,$6,false,'manual',true)
         ON CONFLICT (name_key) DO NOTHING`,
        [key, r.name_en || null, r.name_ar || null, r.developer || null, r.district || null, aliases]
      );
      added += rowCount;
    }
  }
  clearCache();
  return { updated, added };
}

/** The owner checked this place: units can now be matched to it. */
async function approve(pool, id) {
  const { rowCount } = await pool.query("UPDATE map_places SET approved = true, updated_at = now() WHERE id = $1", [id]);
  clearCache();
  return rowCount > 0;
}

/** Approved places only (the list units are matched against). */
async function approvedIndex(pool) {
  const { rows } = await pool.query("SELECT id, name_en, name_ar, aliases, verified, area_id, subzone_id FROM map_places WHERE approved");
  return { rows, index: P.buildIndex(rows) };
}

/**
 * Compound names units use (all agencies) that no approved place answers to yet, most used first. A name an unapproved
 * place (the seed) answers to comes with it as `hint`, so the owner can approve that place in one tap.
 */
async function unmatched(pool, limit = 50) {
  const [{ index }, all] = await Promise.all([approvedIndex(pool), allPlaces(pool)]);
  const { rows } = await pool.query(
    `SELECT l.compound, l.compound_en, count(*)::int AS n, count(DISTINCT l.agency_id)::int AS agencies
       FROM listings l
      WHERE l.status = 'active' AND (l.compound IS NOT NULL OR l.compound_en IS NOT NULL) AND ${Vis.allUnits()}
      GROUP BY l.compound, l.compound_en`
  );
  const byName = new Map();
  for (const r of rows) {
    const typed = r.compound_en || r.compound;
    const { name } = P.splitCompound(typed);
    const hit = P.resolveName(index, typed) || P.resolveName(index, r.compound);
    if (hit && hit.exact) continue;
    const key = P.placeKey(name);
    if (!key) continue;
    const cur = byName.get(key) || { name, other: r.compound_en && r.compound ? r.compound : "", n: 0, agencies: 0 };
    cur.n += r.n;
    cur.agencies = Math.max(cur.agencies, r.agencies);
    byName.set(key, cur);
  }
  return [...byName.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, limit)
    .map((r) => {
      const h = P.resolveName(all.index, r.name);
      const place = h ? all.places.find((x) => x.id === h.id) : null;
      return { ...r, hint: place && !place.approved ? { id: place.id, name: place.name_en || place.name_ar } : null };
    });
}

/**
 * Matches units that are flagged (or have no place yet) to the approved list again: after the owner approves or adds a
 * place, the units that name it are fixed in one go. With apply = false it only counts.
 */
async function recheck(pool, { apply = false } = {}) {
  const { rows: places, index } = await approvedIndex(pool);
  const { rows } = await pool.query(
    `SELECT l.id, l.compound, l.compound_en, l.details FROM listings l
      WHERE ${Vis.allUnits()} AND l.status <> 'deleted' AND l.place_id IS NULL AND coalesce(l.compound, l.compound_en) IS NOT NULL`
  );
  const fixes = [];
  for (const r of rows) {
    const hit = P.resolveName(index, r.compound) || P.resolveName(index, r.compound_en);
    if (!hit || !hit.exact) continue;
    const place = places.find((x) => x.id === hit.id);
    const old = String(r.details?.notes || "").trim();
    const notes = hit.extra && !old.includes(hit.extra) ? [old, hit.extra].filter(Boolean).join(" — ") : old;
    fixes.push({ id: r.id, place_id: place.id, area_id: place.area_id || null, subzone_id: place.subzone_id || null, compound: place.name_ar || place.name_en, compound_en: place.name_en || null, notes });
  }
  if (apply) {
    for (let i = 0; i < fixes.length; i += 300) {
      await pool.query(
        `UPDATE listings l SET place_id = x.place_id, compound_state = NULL, compound = x.compound, compound_en = x.compound_en,
                area_id = COALESCE(x.area_id, l.area_id), subzone_id = CASE WHEN x.area_id IS NOT NULL THEN x.subzone_id ELSE l.subzone_id END,
                details = CASE WHEN x.notes = '' THEN l.details ELSE jsonb_set(l.details, '{notes}', to_jsonb(x.notes)) END
           FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, place_id uuid, area_id uuid, subzone_id uuid, compound text, compound_en text, notes text)
          WHERE l.id = x.id`,
        [JSON.stringify(fixes.slice(i, i + 300))]
      );
    }
  }
  return { checked: rows.length, fixed: fixes.length };
}

/** "Not a compound": units that carry this name (all agencies) lose it; the old text stays in their notes. */
async function dismiss(pool, name) {
  const key = P.placeKey(name);
  if (!key) return 0;
  const { rows } = await pool.query(
    `SELECT l.id, l.compound, l.compound_en, l.details FROM listings l WHERE ${Vis.allUnits()} AND l.place_id IS NULL AND coalesce(l.compound, l.compound_en) IS NOT NULL`
  );
  const ids = rows.filter((r) => P.placeKey(P.splitCompound(r.compound_en || r.compound).name) === key);
  for (const r of ids) {
    const old = String(r.details?.notes || "").trim();
    const note = [old, r.compound_en || r.compound].filter(Boolean).join(" — ");
    await pool.query(
      "UPDATE listings SET compound = NULL, compound_en = NULL, compound_state = NULL, details = jsonb_set(details, '{notes}', to_jsonb($2::text)) WHERE id = $1",
      [r.id, note]
    );
  }
  return ids.length;
}

/** Boot-time sync: approve the master list by name, then link units that now match. Safe to repeat. */
async function syncApproved(pool) {
  const fs = require("fs");
  const path = require("path");
  const rows = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "map-seed", "master.json"), "utf8"));
  const master = await importMaster(pool, rows);
  const units = await recheck(pool, { apply: true });
  return { master, units };
}

module.exports = { termsFor, syncApproved, FINISHING, FURNISHING, allPlaces, clearCache, cleanFilters, pins, facets, unitsAt, place, findByName, list, save, remove, addAlias, importSeed, unmatched, approve, recheck, dismiss, importMaster, TYPES };
