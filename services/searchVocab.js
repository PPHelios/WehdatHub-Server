// services/searchVocab.js — The search words that live in the database (search_aliases): the approved ones are loaded into
// the parser (domain/searchQuery.js setAliases), cached for a minute. A load failure keeps the words already loaded.
"use strict";

const Q = require("../domain/searchQuery");

const TTL_MS = 60 * 1000;
let loadedAt = 0;

/** Loads the approved aliases into the parser. → how many are loaded (or null when the load failed). */
async function refresh(pool) {
  try {
    const { rows } = await pool.query("SELECT term, target FROM search_aliases WHERE status = 'approved'");
    Q.setAliases(rows);
    loadedAt = Date.now();
    return rows.length;
  } catch (err) {
    console.warn("Search vocabulary not loaded:", err.message);
    return null;
  }
}

/** Refreshes at most once a minute; never throws. */
async function ensureLoaded(pool) {
  if (!pool || Date.now() - loadedAt < TTL_MS) return;
  loadedAt = Date.now(); // one load at a time; a failed load is retried after the minute
  await refresh(pool);
}

const reset = () => {
  loadedAt = 0;
};

module.exports = { refresh, ensureLoaded, reset };
