// services/fx.js — Reads and saves each agency's dollar and euro rates (stored in the agency's settings, key "fx"),
// with a short change log ("fx_log", last 20 changes). Only the owner or a manager may save.
"use strict";

const F = require("../domain/fx");
const Vis = require("../lib/visibility");

const LOG_MAX = 20;

/** The agency's rates: { USD, EUR }, each a number or null (not set). */
async function loadRates(db, agencyId) {
  const { rows } = await db.query("SELECT crm_settings->'fx' AS fx FROM agencies WHERE id = $1", [agencyId]);
  return F.ratesFrom(rows[0]?.fx);
}

/** The currencies (of those in the agency's active units) that have no rate yet. */
async function missingRates(db, agencyId, rates) {
  const { rows } = await db.query(
    `SELECT DISTINCT details->>'currency' AS c FROM listings
      WHERE ${Vis.units("listings")} AND agency_id = $1 AND status = 'active' AND details->>'currency' = ANY($2::text[])`,
    [agencyId, F.CURRENCIES]
  );
  return F.missing(rows.map((r) => r.c), rates);
}

/**
 * Saves the rates from a form ({ USD, EUR } as typed). Blank clears a rate. Returns { ok, rates } or { error }.
 * `broker` is the person saving; the log keeps their name, the time, and each old and new value.
 */
async function saveRates(db, broker, input) {
  const next = {};
  for (const c of F.CURRENCIES) {
    const v = F.parseRate(input?.[c]);
    if (v === undefined) return { error: "invalid_rate", currency: c };
    next[c] = v;
  }
  const { rows } = await db.query("SELECT crm_settings->'fx' AS fx, crm_settings->'fx_log' AS log FROM agencies WHERE id = $1 FOR UPDATE", [broker.agency_id]);
  const before = F.ratesFrom(rows[0]?.fx);
  const changes = F.CURRENCIES.filter((c) => before[c] !== next[c]).map((c) => ({ currency: c, from: before[c], to: next[c] }));
  if (!changes.length) return { ok: true, rates: next, changed: false };
  const entry = { at: new Date().toISOString(), by: broker.name || broker.id, changes };
  const log = [...(Array.isArray(rows[0]?.log) ? rows[0].log : []), entry].slice(-LOG_MAX);
  await db.query(
    "UPDATE agencies SET crm_settings = crm_settings || jsonb_build_object('fx', $2::jsonb, 'fx_log', $3::jsonb), updated_at = now() WHERE id = $1",
    [broker.agency_id, JSON.stringify(next), JSON.stringify(log)]
  );
  return { ok: true, rates: next, changed: true };
}

module.exports = { loadRates, missingRates, saveRates };
