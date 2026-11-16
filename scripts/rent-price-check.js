// scripts/rent-price-check.js — Lists rent units whose monthly price looks wrong, for review (read only; nothing is changed).
// Seen on a screenshot: HP310 (rent) read "13.5 million per month". A rent that high is nearly always a yearly price (set
// details.rent_period to "yearly") or a sale price saved on a rent unit. Run it, then fix the units it lists.
// Usage: node --env-file=.env scripts/rent-price-check.js [limit-per-month=1000000] [agency-uuid]
"use strict";

const { createPool } = require("../lib/db");

const LIMIT = Number(process.argv[2]) || 1000000;
const AGENCY = process.argv[3] || null;

/** Rent rows priced above `limit` per month and not marked yearly: [{ agency, code, price, period }]. */
async function suspicious(pool, { limit = LIMIT, agencyId = null } = {}) {
  const { rows } = await pool.query(
    // vis:exempt — a read-only data-quality report for the app owner, across units whatever their visibility
    `SELECT a.name AS agency, l.code, l.price_value AS price, COALESCE(l.details->>'rent_period', 'monthly') AS period
       FROM listings l JOIN agencies a ON a.id = l.agency_id
      WHERE l.listing_type = 'rent' AND l.price_value > $1 AND COALESCE(l.details->>'rent_period', 'monthly') <> 'yearly'
        AND ($2::uuid IS NULL OR l.agency_id = $2::uuid)
      ORDER BY l.price_value DESC LIMIT 200`,
    [limit, agencyId]
  );
  return rows;
}

module.exports = { suspicious };

if (require.main === module) {
  (async () => {
    const pool = createPool();
    try {
      const rows = await suspicious(pool, { limit: LIMIT, agencyId: AGENCY });
      if (!rows.length) console.log(`No rent unit above ${LIMIT} EGP a month.`);
      for (const r of rows) console.log(`${r.agency}\t${r.code}\t${Number(r.price).toLocaleString("en-US")} EGP / ${r.period}`);
    } finally {
      await pool.end();
    }
  })().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
