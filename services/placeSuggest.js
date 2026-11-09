// services/placeSuggest.js — One suggestion list for what a person types in a place box: compounds, their aliases, areas
// and sub-zones together (rules in domain/areas.js). The approved lists are cached for a minute.
"use strict";

const A = require("../domain/areas");
const Areas = require("./areas");

const CACHE_MS = 60 * 1000;
let cache = { at: 0, places: [], areas: [] };

async function lists(pool) {
  if (Date.now() - cache.at < CACHE_MS) return cache;
  const [places, areas] = await Promise.all([
    pool.query("SELECT id, name_en, name_ar, aliases, area_id, subzone_id FROM map_places WHERE approved"),
    Areas.approvedAreas(pool)
  ]);
  cache = { at: Date.now(), places: places.rows, areas };
  return cache;
}

/** Up to `limit` suggestions for the text: [{kind, id, name_en, name_ar, path, via}]. */
async function suggest(pool, text, limit = 8) {
  const { places, areas } = await lists(pool);
  return A.suggest(String(text || "").slice(0, 80), { places, areas }, Math.min(Math.max(1, limit), 20));
}

/** Forget the cached lists (after the owner approves, merges or edits a place or an area). */
function resetCache() {
  cache = { at: 0, places: [], areas: [] };
  require("./areaSearch").resetCache();
}

module.exports = { suggest, resetCache };
