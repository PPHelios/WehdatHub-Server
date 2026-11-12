// lib/saveKeys.js — One save key per unit save, so a repeated try returns the first result (never a second unit).
"use strict";

const KEY = /^[A-Za-z0-9_-]{8,64}$/;

/** The key from a form body, or null when it is missing or malformed (an old page or a script: the save just runs as before). */
function keyOf(body) {
  const k = body && typeof body.save_key === "string" ? body.save_key.trim() : "";
  return KEY.test(k) ? k : null;
}

/**
 * Takes the key inside the save's transaction. { first: true } when this try owns it; otherwise { first: false, code }
 * with the unit the first try saved. A second try that arrives while the first is still running waits on the unique key
 * until the first commits or rolls back, so it never runs twice at once.
 */
async function claim(client, agencyId, key, kind) {
  if (!key) return { first: true };
  const ins = await client.query("INSERT INTO save_keys (agency_id, key, kind) VALUES ($1, $2, $3) ON CONFLICT (agency_id, key) DO NOTHING RETURNING key", [agencyId, key, kind]);
  if (ins.rows.length) return { first: true };
  const { rows } = await client.query("SELECT listing_code FROM save_keys WHERE agency_id = $1 AND key = $2", [agencyId, key]);
  return { first: false, code: rows[0] ? rows[0].listing_code : null };
}

/** Records which unit the key saved (same transaction). */
async function attach(client, agencyId, key, code) {
  if (!key || !code) return;
  await client.query("UPDATE save_keys SET listing_code = $3 WHERE agency_id = $1 AND key = $2", [agencyId, key, code]);
}

/** For the "is it saved?" check: the unit code this key saved, or null. */
async function lookup(pool, agencyId, key) {
  if (!key) return null;
  const { rows } = await pool.query("SELECT listing_code FROM save_keys WHERE agency_id = $1 AND key = $2 AND listing_code IS NOT NULL", [agencyId, key]);
  return rows[0] ? rows[0].listing_code : null;
}

/** Daily: rows older than 7 days. */
async function purgeOld(pool, { now = new Date() } = {}) {
  const { rowCount } = await pool.query("DELETE FROM save_keys WHERE created_at < $1", [new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString()]);
  return { saveKeysPurged: rowCount };
}

module.exports = { keyOf, claim, attach, lookup, purgeOld };
