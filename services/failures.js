// services/failures.js — Failed and refused actions for the CRM owner: a filtered list (agency, day, person) and a daily
// Telegram summary. Sources: operation_logs rows of the failure types below. Rows are kept KEEP_DAYS days.
"use strict";

const { alertOwner } = require("../lib/errorReports");

const TYPES = ["web_failed", "app_failed", "unit_write_refused", "swallowed_error"];
const KEEP_DAYS = 30;
const PAGE = 50;
const DAY = 24 * 3600 * 1000;

/** @returns {Promise<Object[]>} newest first; filters: { agency, person, from, to (Date), offset } */
async function list(pool, { agency = null, person = null, from = null, to = null, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT o.id, o.created_at, o.operation_type, o.error_code, o.listing_code, o.metadata,
            a.name AS agency_name, b.name AS broker_name
       FROM operation_logs o
       LEFT JOIN agencies a ON a.id = o.agency_id
       LEFT JOIN brokers b ON b.id = o.broker_id
      WHERE o.operation_type = ANY($1)
        AND ($2::uuid IS NULL OR o.agency_id = $2)
        AND ($3::uuid IS NULL OR o.broker_id = $3)
        AND ($4::timestamptz IS NULL OR o.created_at >= $4)
        AND ($5::timestamptz IS NULL OR o.created_at < $5)
      ORDER BY o.created_at DESC LIMIT $6 OFFSET $7`,
    [TYPES, agency, person, from, to, PAGE + 1, offset]
  );
  return rows;
}

/** Agencies and people that have failures, for the filter lists. */
async function filters(pool) {
  const [agencies, people] = await Promise.all([
    pool.query("SELECT DISTINCT a.id, a.name FROM operation_logs o JOIN agencies a ON a.id = o.agency_id WHERE o.operation_type = ANY($1) ORDER BY a.name", [TYPES]),
    pool.query("SELECT DISTINCT b.id, b.name, b.agency_id FROM operation_logs o JOIN brokers b ON b.id = o.broker_id WHERE o.operation_type = ANY($1) ORDER BY b.name", [TYPES])
  ]);
  return { agencies: agencies.rows, people: people.rows };
}

/** The last 24 hours as text lines: counts by agency and the most common reasons. null when there were none. */
async function summaryText(pool, now = new Date()) {
  const since = new Date(now.getTime() - DAY);
  const { rows } = await pool.query(
    `SELECT COALESCE(a.name, '—') AS agency, o.error_code AS reason, count(*)::int AS n
       FROM operation_logs o LEFT JOIN agencies a ON a.id = o.agency_id
      WHERE o.operation_type = ANY($1) AND o.created_at >= $2
      GROUP BY 1, 2 ORDER BY n DESC LIMIT 40`,
    [TYPES, since]
  );
  if (!rows.length) return null;
  const total = rows.reduce((s, r) => s + r.n, 0);
  const lines = rows.slice(0, 12).map((r) => `${r.n} × ${r.reason || "?"} (${r.agency})`);
  return [`📋 WehdatHub failures, last 24 h: ${total}`, ...lines, "Details: /app/failures"].join("\n");
}

/** Daily: the summary to the owner on Telegram, and rows older than KEEP_DAYS removed. */
function summaryJob() {
  return {
    name: "failures_daily",
    everyMs: DAY,
    run: async ({ pool, now }) => {
      const at = now ? new Date(now) : new Date();
      const text = await summaryText(pool, at);
      const sent = text ? await alertOwner(text) : false;
      const del = await pool.query("DELETE FROM operation_logs WHERE operation_type = ANY($1) AND created_at < $2", [TYPES, new Date(at.getTime() - KEEP_DAYS * DAY)]);
      return { counts: { sent: sent ? 1 : 0, purged: del.rowCount || 0 } };
    }
  };
}

module.exports = { TYPES, KEEP_DAYS, PAGE, list, filters, summaryText, summaryJob };
