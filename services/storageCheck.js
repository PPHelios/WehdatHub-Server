// services/storageCheck.js — Weekly check of the photo storage: finds files no table points to any more (left behind by
// deleted units, abandoned imports, old flyers). It only REPORTS by default (a dry run: count and size, plus the CRM owner is
// told through system alerts). Files are deleted only when STORAGE_CLEANUP_DELETE=true, and only files older than a week.
"use strict";

const Supabase = require("../lib/supabase");

const BUCKET = "listing-images";
const MIN_AGE_DAYS = 7;
const DELETE_BATCH = 200;

// Every place a stored file's path or link can be kept. A file is in use if any of these mention its name.
const REFERENCES = `
  SELECT url::text AS u FROM listing_images UNION ALL SELECT flyer_url FROM listings UNION ALL SELECT logo_url FROM agencies
  UNION ALL SELECT url FROM project_images UNION ALL SELECT storage_path FROM project_images
  UNION ALL SELECT url FROM project_materials UNION ALL SELECT storage_path FROM project_materials
  UNION ALL SELECT invoice_url FROM commissions
  UNION ALL SELECT collateral::text FROM listings UNION ALL SELECT flyer_cache::text FROM listings UNION ALL SELECT details::text FROM listings
  UNION ALL SELECT brochure::text FROM projects UNION ALL SELECT collateral::text FROM projects UNION ALL SELECT media::text FROM projects
  UNION ALL SELECT photos::text FROM import_rows
  UNION ALL SELECT payload::text FROM web_imports UNION ALL SELECT result::text FROM web_imports`;

/** Files in the app bucket that nothing refers to and that are older than a week: { count, bytes, names (first batch) }. */
async function findOrphans(pool, { limit = DELETE_BATCH } = {}) {
  const has = await pool.query("SELECT to_regclass('storage.objects') AS t");
  if (!has.rows[0]?.t) return { count: 0, bytes: 0, names: [], available: false };
  const sql = `
    WITH refs AS (${REFERENCES}),
    orphans AS (
      SELECT o.name, COALESCE((o.metadata->>'size')::bigint, 0) AS bytes FROM storage.objects o
       WHERE o.bucket_id = $1 AND o.created_at < NOW() - make_interval(days => $2::int)
         AND NOT EXISTS (SELECT 1 FROM refs r WHERE r.u IS NOT NULL AND position(o.name IN r.u) > 0))
    SELECT (SELECT count(*)::int FROM orphans) AS count, (SELECT COALESCE(sum(bytes), 0)::bigint FROM orphans) AS bytes,
           ARRAY(SELECT name FROM orphans ORDER BY name LIMIT $3) AS names`;
  const { rows } = await pool.query(sql, [BUCKET, MIN_AGE_DAYS, limit]);
  return { count: rows[0].count, bytes: Number(rows[0].bytes), names: rows[0].names, available: true };
}

/** One weekly run: reports the orphans; deletes a batch of them only when the delete switch is on. */
async function run(pool, { deleteFiles = process.env.STORAGE_CLEANUP_DELETE === "true" } = {}) {
  const found = await findOrphans(pool);
  let deleted = 0;
  if (deleteFiles && found.names.length) {
    const ok = await Supabase.deleteStorageFiles(found.names);
    if (ok) deleted = found.names.length;
  }
  return { orphans: found.count, orphan_bytes: found.bytes, deleted, dry_run: !deleteFiles };
}

const checkJob = () => ({ name: "storage_check", everyMs: 7 * 24 * 3600 * 1000, run: ({ pool }) => run(pool).then((counts) => ({ counts, watermark: { orphans: counts.orphans, bytes: counts.orphan_bytes, dry_run: counts.dry_run } })) });

module.exports = { BUCKET, MIN_AGE_DAYS, findOrphans, run, checkJob };
