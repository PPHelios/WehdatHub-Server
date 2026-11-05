// services/unitDelete.js — Soft delete of a unit (migration 075): delete keeps it 10 days, managers and the owner restore it
// from "Recently deleted", and after 10 days the purge job removes its photos and row, leaving the reference facts in
// unit_reference. Whoever may edit a unit may delete it (Authz.canEdit); only managers and the owner see and restore.
"use strict";

const Authz = require("../lib/authz");
const Supabase = require("../lib/supabase");
const { withTransaction } = require("../lib/db");
const Vis = require("../lib/visibility");

const RETENTION_DAYS = 10;
const DAY = 24 * 3600 * 1000;

/** Locks the unit's row for a change; { ok, listing } | { error }. The caller's transaction is the client. */
async function lockUnit(client, actor, listingId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(listingId || ""))) return { error: "not_found" };
  const { rows } = await client.query(`SELECT * FROM listings WHERE ${Vis.units("listings")} AND id = $1 AND agency_id = $2 FOR UPDATE`, [listingId, actor.agency_id]);
  return rows[0] ? { ok: true, listing: rows[0] } : { error: "not_found" };
}

/** Runs work in the given transaction client, or opens one. */
const inTx = (pool, client, fn) => (client ? fn(client) : withTransaction(pool, fn));

/**
 * Deletes a unit (keeps it for 10 days). Returns { ok, code, restoreUntil } | { error }. The caller may pass the transaction
 * `client` that already holds the unit's advisory lock (routes/interactive.js does).
 */
async function softDelete(pool, actor, listingId, { now = new Date(), client = null } = {}) {
  return inTx(pool, client, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [String(actor.agency_id), String(listingId)]);
    const r = await lockUnit(c, actor, listingId);
    if (r.error) return r;
    const l = r.listing;
    if (l.status === "deleted") return { error: "already_deleted" };
    if (!Authz.canEdit(actor, l)) return { error: "forbidden" };
    await c.query(
      "UPDATE listings SET status = 'deleted', deleted_at = $2, deleted_by = $3, version = version + 1, updated_at = $2 WHERE id = $1",
      [l.id, now.toISOString(), actor.id]
    );
    return { ok: true, code: l.code, restoreUntil: new Date(now.getTime() + RETENTION_DAYS * DAY) };
  });
}

/** Brings a deleted unit back as available (managers and the owner). */
async function restore(pool, actor, listingId, { now = new Date() } = {}) {
  if (!Authz.isManager(actor)) return { error: "forbidden" };
  return withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [String(actor.agency_id), String(listingId)]);
    const r = await lockUnit(client, actor, listingId);
    if (r.error) return r;
    if (r.listing.status !== "deleted") return { error: "not_deleted" };
    if (r.listing.deleted_at && new Date(r.listing.deleted_at).getTime() < now.getTime() - RETENTION_DAYS * DAY) return { error: "expired" };
    await client.query("UPDATE listings SET status = 'active', deleted_at = NULL, deleted_by = NULL, version = version + 1, updated_at = $2 WHERE id = $1", [r.listing.id, now.toISOString()]);
    return { ok: true, code: r.listing.code };
  });
}

/** Managers and the owner: the deleted units, newest deletion first, with the days left to restore each. */
async function listDeleted(pool, actor, { now = new Date() } = {}) {
  if (!Authz.isManager(actor)) return null;
  const { rows } = await pool.query(
    `SELECT id, code, property_type, compound, price_value, area_value, deleted_at, deleted_by FROM listings
      WHERE ${Vis.units("listings")} AND agency_id = $1 AND status = 'deleted' ORDER BY deleted_at DESC NULLS LAST, id DESC LIMIT 200`,
    [actor.agency_id]
  );
  return rows.map((r) => ({ ...r, daysLeft: Math.max(0, Math.ceil((new Date(r.deleted_at).getTime() + RETENTION_DAYS * DAY - now.getTime()) / DAY)) }));
}

/**
 * The purge: units deleted more than 10 days ago. Each one's reference facts go to unit_reference first, then its row goes
 * (its photos, links and payment plans go with it through the foreign keys; leads and deals keep their history, unlinked).
 * Photos are removed from storage after the commit, never inside it. → { purged }
 */
async function purgeDue(pool, { now = new Date(), limit = 100 } = {}) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY).toISOString();
  const { rows: due } = await pool.query(`SELECT id FROM listings WHERE ${Vis.allUnits()} AND status = 'deleted' AND deleted_at < $1 ORDER BY deleted_at LIMIT $2`, [cutoff, limit]);
  let purged = 0;
  for (const { id } of due) {
    const photos = await withTransaction(pool, async (client) => {
      const { rows } = await client.query(`SELECT * FROM listings WHERE ${Vis.allUnits()} AND id = $1 AND status = 'deleted' AND deleted_at < $2 FOR UPDATE`, [id, cutoff]);
      const l = rows[0];
      if (!l) return null;
      const { rows: imgs } = await client.query("SELECT url FROM listing_images WHERE listing_id = $1", [l.id]);
      await client.query(
        `INSERT INTO unit_reference (agency_id, code, listing_type, market, property_type, compound, compound_en, district, city, area_value, bedrooms, bathrooms,
                                     price_value, currency, finishing, furnishing, delivery_year, created_at, deleted_at, purged_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        [
          l.agency_id, l.code, l.listing_type, l.market, l.property_type, l.compound, l.compound_en, l.district, l.city, l.area_value, l.bedrooms,
          l.bathrooms, l.price_value, l.details?.currency || null, l.finishing, l.furnishing, l.delivery_year, l.created_at, l.deleted_at, now.toISOString()
        ]
      );
      await client.query(`DELETE FROM listings WHERE ${Vis.allUnits()} AND id = $1`, [l.id]);
      return imgs.map((r) => r.url);
    });
    if (photos === null) continue;
    purged += 1;
    if (photos.length) setImmediate(() => Supabase.deleteStorageFiles(photos).catch((e) => console.warn("Photo purge failed:", e.message)));
  }
  return { purged };
}

const purgeJob = () => ({ name: "unit_purge", everyMs: 60 * 60 * 1000, run: ({ pool, now }) => purgeDue(pool, { now }).then((counts) => ({ counts })) });

module.exports = { RETENTION_DAYS, softDelete, restore, listDeleted, purgeDue, purgeJob };
