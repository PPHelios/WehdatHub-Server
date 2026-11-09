// services/compoundResolve.js — A unit's compound is normalized on entry: matched to the approved list of places, the
// canonical names written back, details written after the name moved to the unit's notes. A name that does not match
// keeps what was typed and the unit is marked needs_fix (it stays saved and searchable).
"use strict";

const P = require("../domain/mapPlaces");
const A = require("../domain/areas");
const Areas = require("./areas");

/** Approved places, indexed. `db` is a client or the pool. */
async function approvedIndex(db) {
  const { rows } = await db.query("SELECT id, name_en, name_ar, aliases, verified, area_id, subzone_id FROM map_places WHERE approved");
  return { rows, index: P.buildIndex(rows) };
}

/**
 * The unit's area and sub-zone. The compound's own area wins; otherwise the area picked on the unit, then the one its
 * district text names. A sub-zone that is not under the area is dropped.
 */
function locate(areas, fields, place) {
  const index = A.buildIndex(areas);
  let area_id = place?.area_id || null;
  let subzone_id = place?.area_id ? place.subzone_id || null : null;
  if (!area_id && fields.area_id && areas.some((a) => a.id === fields.area_id)) {
    area_id = fields.area_id;
    subzone_id = fields.subzone_id || null;
  }
  if (!area_id) {
    const hit = [fields.district, fields.city].map((t) => (t ? A.resolveArea(index, t) : null)).find((h) => h?.id);
    if (hit) ({ area_id, subzone_id } = A.placement(areas, hit.id));
  }
  if (area_id && subzone_id && !A.checkLocation({ area_id, subzone_id }, { kind: "unit", areas }).ok) subzone_id = null;
  return { area_id, subzone_id };
}

/**
 * Column changes for the compound the fields carry. Returns {} when there is nothing to normalize.
 * A typed name that is an area or sub-zone (not a compound) sets the area instead of waiting as a new compound.
 * @param {Object} fields listing columns (compound, compound_en) and details
 */
async function resolve(db, fields) {
  const typed = String(fields.compound || fields.compound_en || "").trim();
  const areas = await Areas.approvedAreas(db);
  if (!typed) return { place_id: null, compound_state: null, ...locate(areas, fields, null) };
  const { rows, index } = await approvedIndex(db);
  const hit = P.resolveName(index, typed) || P.resolveName(index, fields.compound_en);
  if (!hit || !hit.exact) {
    const { name, extra } = P.splitCompound(typed);
    const asArea = A.resolveArea(A.buildIndex(areas), name || typed);
    if (asArea?.id) return { place_id: null, compound_state: null, compound: null, compound_en: null, ...locate(areas, { ...fields, ...A.placement(areas, asArea.id) }, null), ...(extra ? { extra } : {}) };
    return { place_id: null, compound_state: "needs_fix", compound: name || typed, ...locate(areas, fields, null), ...(extra ? { extra } : {}) };
  }
  const place = rows.find((r) => r.id === hit.id);
  return { place_id: place.id, compound_state: null, compound: place.name_ar || place.name_en, compound_en: place.name_en || null, ...locate(areas, fields, place), ...(hit.extra ? { extra: hit.extra } : {}) };
}

/** `resolve` applied to a fields object: returns the object with the compound columns, place, state, and extra text in details.notes. */
async function normalize(db, fields, { brokerId = null, batch = null } = {}) {
  const r = await resolve(db, fields);
  const { extra, ...cols } = r;
  // An edit that does not name an area keeps the unit's area unless the compound now brings one.
  if (cols.area_id == null && !("area_id" in fields)) {
    delete cols.area_id;
    delete cols.subzone_id;
  }
  // A name that is not on the list waits for the CRM owner (alerted once per name); the unit is saved and flagged.
  if (r.compound_state === "needs_fix") await require("../lib/placeNames").noteUnknown(db, r.compound, { example: "unit", brokerId: brokerId || fields.broker_id || null, batch }).catch(() => {});
  const out = { ...fields, ...cols };
  if (extra) {
    const old = String(fields.details?.notes || "").trim();
    out.details = { ...(fields.details || {}), notes: old.includes(extra) ? old : [old, extra].filter(Boolean).join(" — ") };
  }
  return out;
}

/** The approved places that look most like what was typed (spelling variants), best first. Suggestions only; never applied alone. */
async function suggest(db, typed, limit = 3) {
  const { rows } = await approvedIndex(db);
  const key = P.placeKey(P.splitCompound(typed).name);
  if (!key) return [];
  return rows
    .map((r) => ({ id: r.id, name: r.name_en || r.name_ar, name_ar: r.name_ar, score: Math.max(...P.keysOf(r).map((k) => P.dice(key, k)), 0) }))
    .filter((r) => r.score >= 0.45)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

module.exports = { resolve, normalize, suggest };
