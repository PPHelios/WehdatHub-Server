// services/areaSearch.js — Search by area: a place word that is the name or alias of one area or sub-zone becomes a filter on
// the unit's area (the sub-zone and everything below it), so a search for "Al Banafseg" finds the units there even when their
// compound is not typed in the same words.
"use strict";

const A = require("../domain/areas");
const Phases = require("../domain/phases");
const Areas = require("./areas");
const GROUPS = require("../data/areas/compound-phases.json").groups || [];

const CACHE_MS = 60 * 1000;
let cache = { at: 0, areas: [], places: [] };

async function approved(pool) {
  if (Date.now() - cache.at < CACHE_MS) return cache.areas;
  cache = {
    at: Date.now(),
    areas: await Areas.approvedAreas(pool).catch(() => []),
    places: await pool.query("SELECT id, name_en, name_ar, aliases, area_id, subzone_id FROM map_places WHERE approved").then((r) => r.rows).catch(() => [])
  };
  return cache.areas;
}

/** Forget the cached list (after areas change). */
function resetCache() {
  cache = { at: 0, areas: [], places: [] };
}

const below = (areas, id) => {
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const a of areas) if (a.parent_id === out[i] && !out.includes(a.id)) out.push(a.id);
  return out;
};

/**
 * @param {string[]} terms place words from the search
 * @returns {Promise<{scope: {areas: string[], subzones: string[]}|null, rest: string[]}>} scope = what the matched words filter on; rest = words that are not areas
 */
async function scope(pool, terms) {
  const areas = await approved(pool);
  const index = A.buildIndex(areas);
  const out = { areas: [], subzones: [] };
  const rest = [];
  for (const t of terms) {
    const hit = A.resolveArea(index, t);
    const node = hit?.id ? areas.find((a) => a.id === hit.id) : null;
    if (!node) rest.push(t);
    else if (!node.parent_id) out.areas.push(node.id);
    else out.subzones.push(...below(areas, node.id));
  }
  return { scope: out.areas.length || out.subzones.length ? out : null, rest };
}

/**
 * A phase named in the search text ("madinaty b6", "الرحاب مرحلة 7") narrows the search to that phase: { scope: {areas: [], subzones: [phaseId]}, words }.
 * The compound word still filters as before (Madinaty alone finds every phase). Null when no phase is named.
 */
async function phaseScope(pool, text) {
  await approved(pool);
  const hit = Phases.findPhase(text, { places: cache.places, areas: cache.areas });
  if (hit) return { scope: { areas: [], subzones: [hit.phase.id] }, words: hit.words };
  // "Rehab 1" / "Rehab 2": an alias for several phases (the groups in the data file).
  const group = Phases.findGroup(text, { places: cache.places, areas: cache.areas }, GROUPS);
  return group ? { scope: { areas: [], subzones: group.ids }, words: group.words } : null;
}

module.exports = { scope, phaseScope, resetCache };
