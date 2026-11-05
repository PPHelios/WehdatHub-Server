// services/linkCleanup.js — Expired and revoked client links are removed in batches: a unit or comparison link past its 180
// days (or revoked more than 30 days ago), and with it its open log (share_link_opens cascades). Nothing else is touched:
// the units, leads and the lead's own history stay. Runs hourly.
"use strict";

const BATCH = 500;
const REVOKED_KEEP_DAYS = 30;

/** → { links, compares } removed in this run (at most BATCH of each). */
async function cleanup(pool, { now = new Date() } = {}) {
  const revokedBefore = new Date(now.getTime() - REVOKED_KEEP_DAYS * 24 * 3600 * 1000).toISOString();
  const { rowCount: links } = await pool.query(
    `DELETE FROM share_links WHERE token_hash IN (
       SELECT token_hash FROM share_links
        WHERE expires_at < $1 OR (revoked_at IS NOT NULL AND revoked_at < $2)
        LIMIT $3)`,
    [now.toISOString(), revokedBefore, BATCH]
  );
  const { rowCount: compares } = await pool.query(
    `DELETE FROM compare_links WHERE token_hash IN (
       SELECT token_hash FROM compare_links
        WHERE expires_at < $1 OR (revoked_at IS NOT NULL AND revoked_at < $2)
        LIMIT $3)`,
    [now.toISOString(), revokedBefore, BATCH]
  );
  return { links: links || 0, compares: compares || 0 };
}

const cleanupJob = () => ({ name: "link_cleanup", everyMs: 60 * 60 * 1000, run: ({ pool, now }) => cleanup(pool, { now }).then((counts) => ({ counts })) });

module.exports = { BATCH, REVOKED_KEEP_DAYS, cleanup, cleanupJob };
