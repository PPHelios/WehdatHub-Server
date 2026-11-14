// services/savedSearches.js — A broker's saved searches (the same on the website and in the app): save the filters of a search under a name,
// list them with how many units fit and how many are new since last opened, open one (marks what was seen), delete one.
"use strict";

const Search = require("./search");
const SearchLink = require("../domain/searchLink");
const Q = require("../domain/searchQuery");

const MAX_SAVED = 50;
const MAX_ALERTING = 30; // open client requests (alerting searches, tied to a lead or not) per broker
const UUID = /^[0-9a-f-]{36}$/;
const mine = "agency_id = $1 AND broker_id = $2 AND lead_id IS NULL";

/** { ok, id } | { error: 'invalid' | 'limit' }. `token` is the filters token a search gives (domain/searchLink.js). */
async function save(pool, broker, { token, name, alerts = false }) {
  const filters = SearchLink.decodeFilters(String(token || ""));
  const label = String(name || "").trim().slice(0, 80);
  if (!filters || !Q.hasAnyFilter({ filters }) || !label) return { error: "invalid" };
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM saved_searches WHERE ${mine}`, [broker.agency_id, broker.id]);
  if (rows[0].n >= MAX_SAVED) return { error: "limit" };
  const wantAlerts = alerts === true || alerts === "1" || alerts === "on" || alerts === "true";
  if (wantAlerts && (await alertingCount(pool, broker)) >= MAX_ALERTING) return { error: "limit_alerts" };
  const out = await Search.runSearch(pool, broker.agency_id, { filters });
  const ins = await pool.query(
    "INSERT INTO saved_searches (agency_id, broker_id, name, filters, seen_ids, last_run_at, alerts_enabled) VALUES ($1, $2, $3, $4::jsonb, $5::uuid[], NOW(), $6) RETURNING id",
    [broker.agency_id, broker.id, label, JSON.stringify(filters), out.ids, wantAlerts]
  );
  // What already fits is recorded as seen, so only units that newly fit alert the broker.
  if (wantAlerts && out.ids.length) {
    await pool.query(
      `INSERT INTO lead_matches (agency_id, lead_id, search_id, listing_id, status, created_at)
       SELECT $1, NULL, $2, unnest($3::uuid[]), 'new', now() ON CONFLICT (search_id, listing_id) DO NOTHING`,
      [broker.agency_id, ins.rows[0].id, out.ids]
    );
  }
  return { ok: true, id: ins.rows[0].id };
}

/** The broker's open client requests: every alerting search of theirs, tied to a lead or not. */
async function alertingCount(pool, broker) {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM saved_searches WHERE agency_id = $1 AND broker_id = $2 AND alerts_enabled", [broker.agency_id, broker.id]);
  return rows[0].n;
}

/** [{ id, name, filters, total, fresh }]: each search with how many units fit now and how many are new since it was last opened. */
async function list(pool, broker) {
  const { rows } = await pool.query(`SELECT id, name, filters, seen_ids, alerts_enabled FROM saved_searches WHERE ${mine} ORDER BY created_at DESC`, [broker.agency_id, broker.id]);
  const items = [];
  for (const s of rows) {
    const filters = SearchLink.sanitizeFilters(s.filters);
    const out = await Search.runSearch(pool, broker.agency_id, { filters });
    const seen = new Set(s.seen_ids || []);
    items.push({ id: s.id, name: s.name, alerts: s.alerts_enabled, filters, total: out.total, fresh: out.ids.filter((id) => !seen.has(id)).length });
  }
  return items;
}

/** The saved search row with its sanitized filters, or null. */
async function get(pool, broker, id) {
  if (!UUID.test(String(id))) return null;
  const { rows } = await pool.query(`SELECT * FROM saved_searches WHERE id = $3 AND ${mine}`, [broker.agency_id, broker.id, id]);
  return rows[0] ? { ...rows[0], filters: SearchLink.sanitizeFilters(rows[0].filters) } : null;
}

/** Marks the ids as seen (the search was just opened). */
async function markSeen(pool, id, ids) {
  await pool.query("UPDATE saved_searches SET seen_ids = $2::uuid[], last_run_at = NOW() WHERE id = $1", [id, ids]);
}

async function remove(pool, broker, id) {
  if (!UUID.test(String(id))) return false;
  const r = await pool.query(`DELETE FROM saved_searches WHERE id = $3 AND ${mine}`, [broker.agency_id, broker.id, id]);
  return r.rowCount > 0;
}

module.exports = { MAX_ALERTING, alertingCount, MAX_SAVED, save, list, get, markSeen, remove };
