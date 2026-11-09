// services/areaSearch.js — Search by area: a place word that is the name or alias of one area or sub-zone becomes a filter on
// the unit's area (the sub-zone and everything below it), so a search for "Al Banafseg" finds the units there even when their
// compound is not typed in the same words.
"use strict";

const A = require("../domain/areas");
const Areas = require("./areas");

const CACHE_MS = 60 * 1000;
let cache = { at: 0, areas: [] };

async function approved(pool) {
  if (Date.now() - cache.at < CACHE_MS) return cache.areas;
  cache = { at: Date.now(), areas: await Areas.approvedAreas(pool).catch(() => []) };
  return cache.areas;
}

/** Forget the cached list (after areas change). */
function resetCache() {
  cache = { at: 0, areas: [] };
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

module.exports = { scope, resetCache };
