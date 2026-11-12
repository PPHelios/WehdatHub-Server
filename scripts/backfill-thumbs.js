// scripts/backfill-thumbs.js — Makes the small copy (thumbs/<key>) of every listing photo that has none yet.
// Usage: node scripts/backfill-thumbs.js [--limit 500]   (run it again until it prints "done"; safe to repeat)
// Reads each original, writes only the small copy; never changes or deletes an original. Failures are counted, not fatal.
"use strict";

const { createPool } = require("../lib/db");
const Supabase = require("../lib/supabase");

async function main() {
  const limit = Math.max(1, Number((process.argv.find((a, i, all) => all[i - 1] === "--limit") || 500)) || 500);
  const pool = createPool();
  let made = 0, skipped = 0, failed = 0, last = "00000000-0000-0000-0000-000000000000";
  try {
    while (made + failed < limit) {
      const { rows } = await pool.query(
        "/* vis:exempt: maintenance job over every agency's photos */ SELECT id, url FROM listing_images WHERE id > $1 AND url <> '' ORDER BY id LIMIT 50",
        [last]
      );
      if (!rows.length) { console.log(JSON.stringify({ done: true, made, skipped, failed })); return; }
      for (const r of rows) {
        last = r.id;
        const key = Supabase.thumbKey(r.url);
        if (!key) { skipped++; continue; }
        const head = await fetch(Supabase.photoUrl(key), { method: "HEAD" }).catch(() => null);
        if (head && head.ok) { skipped++; continue; }
        const got = await Supabase.downloadListingImage(r.url);
        if (!got) { failed++; continue; }
        (await Supabase.uploadThumb(r.url, got.buffer)) ? made++ : failed++;
      }
    }
    console.log(JSON.stringify({ done: false, made, skipped, failed, next_after: last }));
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
