// lib/unitUploads.js — Photos that go straight from the phone to storage while a unit is added or edited.
// The server only hands out one-time upload links (sign), checks at Save that each named photo really is there and is the
// broker's own (verify), and marks them used inside the unit's transaction (attach). Unused ones are cleaned up daily.
"use strict";

const crypto = require("crypto");
const Supabase = require("./supabase");
const { MAX_PHOTOS } = require("./images");

const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_BYTES = 10 * 1024 * 1024; // the bucket's own limit
const LINKS_PER_HOUR = 90; // 6 full units of photos an hour is far above real use
const HOUR = 3600 * 1000;

/** The photo keys named in a form or JSON body: an array, a repeated field, a JSON text or one key; valid and unique, in order. */
function keysOf(body) {
  let v = body && body.photo_keys;
  if (typeof v === "string") {
    try {
      const j = JSON.parse(v);
      if (Array.isArray(j)) v = j;
    } catch {
      /* a single key */
    }
  }
  const all = [].concat(v || []).filter((k) => typeof k === "string" && KEY.test(k));
  return [...new Set(all)].slice(0, MAX_PHOTOS);
}

/** { uploads: [{ key, upload_url, thumb_key, thumb_upload_url }] }, or { limited } / { failed }. */
async function sign(pool, broker, count, source = "web") {
  const n = Math.max(1, Math.min(Number(count) || 1, MAX_PHOTOS));
  const recent = (await pool.query("SELECT count(*)::int AS n FROM unit_photo_uploads WHERE broker_id = $1 AND created_at > now() - interval '1 hour'", [broker.id])).rows[0].n;
  if (recent + n > LINKS_PER_HOUR) return { limited: true };
  const made = [];
  for (let i = 0; i < n; i++) {
    const key = crypto.randomBytes(12).toString("base64url");
    const path = `listings/${broker.agency_id}/${source}/${broker.id}/${Date.now()}_${key}.jpg`;
    const thumbPath = Supabase.thumbKey(path);
    const [url, thumbUrl] = await Promise.all([Supabase.createSignedUpload(path), Supabase.createSignedUpload(thumbPath)]);
    if (!url) return { failed: true };
    made.push({ key, path, thumbPath, url, thumbUrl });
  }
  for (const m of made) {
    await pool.query("INSERT INTO unit_photo_uploads (key, agency_id, broker_id, path, thumb_path) VALUES ($1, $2, $3, $4, $5)", [m.key, broker.agency_id, broker.id, m.path, m.thumbPath]);
  }
  return { uploads: made.map((m) => ({ key: m.key, upload_url: m.url, thumb_key: m.thumbPath, thumb_upload_url: m.thumbUrl || null })) };
}

/**
 * Before the transaction: each key must be this broker's own, unused, recent, and really in storage as an image within the size
 * limit. { paths (same order as keys), missing: [keys that failed] }.
 */
async function verify(pool, broker, keys) {
  if (!keys.length) return { paths: [], missing: [] };
  const { rows } = await pool.query(
    `SELECT key, path FROM unit_photo_uploads
      WHERE key = ANY($1::text[]) AND broker_id = $2 AND agency_id = $3 AND attached_at IS NULL AND created_at > now() - interval '24 hours'`,
    [keys, broker.id, broker.agency_id]
  );
  const pathOf = new Map(rows.map((r) => [r.key, r.path]));
  const missing = [];
  await Promise.all(
    keys.map(async (k) => {
      const path = pathOf.get(k);
      const info = path ? await Supabase.objectInfo(path) : null;
      if (!info || !info.size || info.size > MAX_BYTES || !/^image\//i.test(info.contentType)) missing.push(k);
    })
  );
  return { paths: keys.map((k) => pathOf.get(k)), missing: keys.filter((k) => missing.includes(k)) };
}

/** Inside the unit's transaction: marks the keys used. False when any of them was used meanwhile (a second save). */
async function attach(client, broker, keys) {
  if (!keys.length) return true;
  const { rows } = await client.query(
    "UPDATE unit_photo_uploads SET attached_at = now() WHERE key = ANY($1::text[]) AND broker_id = $2 AND agency_id = $3 AND attached_at IS NULL RETURNING key",
    [keys, broker.id, broker.agency_id]
  );
  return rows.length === keys.length;
}

/** For a page that reopens with photos already uploaded (a reload, a closed tab): the keys that are still good, with their links. */
async function ready(pool, broker, keys) {
  const v = await verify(pool, broker, keys);
  return keys
    .map((k, i) => ({ key: k, path: v.paths[i] }))
    .filter((r) => r.path && !v.missing.includes(r.key))
    .map((r) => ({ key: r.key, url: Supabase.photoUrl(r.path), thumb: Supabase.thumbUrl(r.path) }));
}

/** Daily: photos never attached are removed after 24 hours (with their small copy); used rows are forgotten after 7 days. */
async function purgeOld(pool, { now = new Date() } = {}) {
  const { rows } = await pool.query("SELECT key, path, thumb_path FROM unit_photo_uploads WHERE attached_at IS NULL AND created_at < $1 LIMIT 500", [new Date(now.getTime() - 24 * HOUR).toISOString()]);
  let purged = 0;
  if (rows.length) {
    const ok = await Supabase.deleteStorageFiles(rows.flatMap((r) => [r.path, r.thumb_path]));
    if (ok) {
      await pool.query("DELETE FROM unit_photo_uploads WHERE key = ANY($1::text[])", [rows.map((r) => r.key)]);
      purged = rows.length;
    }
  }
  const old = await pool.query("DELETE FROM unit_photo_uploads WHERE attached_at < $1", [new Date(now.getTime() - 7 * 24 * HOUR).toISOString()]);
  return { uploadsPurged: purged, uploadsForgotten: old.rowCount };
}

module.exports = { keysOf, sign, verify, attach, ready, purgeOld };
