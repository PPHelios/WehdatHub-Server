// lib/logRollup.js — Detail logs live 90 days. After that each day becomes one summary row per agency and name
// (count, ok count, average and largest time) in log_daily_summary, and the detail rows are deleted — same transaction.
// Runs inside the privacy job; at most 14 days per source per run so a first run on a big table stays small.
"use strict";

const DAY_MS = 86400000;
const KEEP_DAYS = 90;
const CHUNK_DAYS = 14;
const NIL = "00000000-0000-0000-0000-000000000000";

// Per source: the table, the day's name/ok/ms columns, and what must stay as detail (the outbound counter reads wa_outbound rows).
const SOURCES = [
  { source: "usage_events", table: "usage_events", name: "event", ok: "ok", ms: "ms", where: "TRUE" },
  { source: "operation_logs", table: "operation_logs", name: "operation_type", ok: "(status IS DISTINCT FROM 'failed' AND status IS DISTINCT FROM 'error')", ms: "total_duration_ms", where: "operation_type <> 'wa_outbound'" },
  { source: "search_log", table: "search_log", name: "channel || ':' || source", ok: "(source <> 'fallback')", ms: "NULL::int", where: "TRUE" }
];

/** The Cairo midnight (UTC+2 fixed, close enough for a retention edge) that starts the kept window. */
function cutoff(now) {
  const cairo = new Date(now.getTime() - KEEP_DAYS * DAY_MS + 2 * 3600000);
  cairo.setUTCHours(0, 0, 0, 0);
  return new Date(cairo.getTime() - 2 * 3600000);
}

async function rollSource(pool, s, cut) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const oldest = (await client.query(`SELECT min(created_at) AS t FROM ${s.table} WHERE created_at < $1 AND ${s.where}`, [cut.toISOString()])).rows[0].t;
    if (!oldest) {
      await client.query("COMMIT");
      return 0;
    }
    const end = new Date(Math.min(cut.getTime(), new Date(oldest).getTime() + CHUNK_DAYS * DAY_MS));
    await client.query(
      `INSERT INTO log_daily_summary (day, agency_id, source, name, n, ok_n, ms_n, ms_sum, ms_avg, ms_max)
       SELECT (created_at AT TIME ZONE 'Africa/Cairo')::date, COALESCE(agency_id, $3::uuid), $4::text, ${s.name}, count(*), count(*) FILTER (WHERE ${s.ok}),
              count(${s.ms}), COALESCE(sum(${s.ms}), 0), round(avg(${s.ms}))::int, max(${s.ms})
         FROM ${s.table} WHERE created_at < $1 AND created_at >= $2 AND ${s.where}
        GROUP BY 1, 2, 4
       ON CONFLICT (day, agency_id, source, name) DO UPDATE SET
         n = log_daily_summary.n + EXCLUDED.n, ok_n = log_daily_summary.ok_n + EXCLUDED.ok_n, ms_n = log_daily_summary.ms_n + EXCLUDED.ms_n,
         ms_sum = log_daily_summary.ms_sum + EXCLUDED.ms_sum,
         ms_avg = CASE WHEN log_daily_summary.ms_n + EXCLUDED.ms_n > 0 THEN ((log_daily_summary.ms_sum + EXCLUDED.ms_sum) / (log_daily_summary.ms_n + EXCLUDED.ms_n))::int END,
         ms_max = GREATEST(log_daily_summary.ms_max, EXCLUDED.ms_max)`,
      [end.toISOString(), new Date(0).toISOString(), NIL, s.source]
    );
    const del = await client.query(`DELETE FROM ${s.table} WHERE created_at < $1 AND ${s.where}`, [end.toISOString()]);
    await client.query("COMMIT");
    return del.rowCount;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** { rolled_usage_events, rolled_operation_logs, rolled_search_log }: detail rows turned into summary rows and removed. */
async function rollUp(pool, { now = new Date() } = {}) {
  const cut = cutoff(now);
  const out = {};
  for (const s of SOURCES) out[`rolled_${s.source}`] = await rollSource(pool, s, cut);
  return out;
}

module.exports = { rollUp, cutoff, KEEP_DAYS };
