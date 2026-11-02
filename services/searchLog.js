// services/searchLog.js — The search log (POC): every search with what was read, what was used and what came back,
// and the "Wrong search" reports brokers send from a result. Logging never breaks a search.
"use strict";

const MAX_TEXT = 300;
const MAX_IDS = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v) => UUID_RE.test(String(v || ""));

/** The words as typed or spoken, with phone-like number runs hidden (a search may carry a client's number). */
function cleanText(text) {
  return String(text || "")
    .replace(/[+٠-٩\d][٠-٩\d\s().-]{6,}[٠-٩\d]/g, "…")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT);
}

/**
 * Saves one search. Returns the log id, or null when it could not be saved.
 * parse: the reading ({ source, local, ai, parsed, reasons }); used: the filters that ran.
 */
async function record(pool, { broker, channel, text = "", parse = {}, used = null, total = 0, ids = [], relaxed = false, rerunOf = null }) {
  try {
    const meta = parse.parsed?.meta || parse.local?.meta || {};
    const { rows } = await pool.query(
      `INSERT INTO search_log (agency_id, broker_id, channel, query_text, source, reasons, local_filters, ai_filters, used_filters,
                               unapplied, leftover, total, relaxed, result_ids, rerun_of)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7::jsonb, $8::jsonb, $9::jsonb, $10::text[], $11::text[], $12, $13, $14::uuid[], $15)
       RETURNING id`,
      [
        broker.agency_id,
        broker.id,
        channel,
        cleanText(text),
        parse.source || "form",
        parse.reasons || [],
        parse.local ? JSON.stringify(parse.local.filters) : null,
        parse.ai ? JSON.stringify(parse.ai.filters) : null,
        used ? JSON.stringify(used) : null,
        meta.unapplied || [],
        meta.leftover || [],
        Number(total) || 0,
        Boolean(relaxed),
        (ids || []).slice(0, MAX_IDS),
        isId(rerunOf) ? rerunOf : null
      ]
    );
    return rows[0]?.id || null;
  } catch (err) {
    console.warn("Search log failed:", err.message);
    return null;
  }
}

/** A "Wrong search" report on one of the broker's own searches. → { ok } | { error: "not_found" | "again" } */
async function report(pool, broker, logId, note = "") {
  if (!isId(logId)) return { error: "not_found" };
  const { rows } = await pool.query("SELECT id FROM search_log WHERE id = $1 AND agency_id = $2 AND broker_id = $3", [logId, broker.agency_id, broker.id]);
  if (!rows[0]) return { error: "not_found" };
  const ins = await pool.query(
    `INSERT INTO search_reports (search_log_id, agency_id, broker_id, note) VALUES ($1, $2, $3, $4)
     ON CONFLICT (search_log_id, broker_id) DO NOTHING RETURNING id`,
    [logId, broker.agency_id, broker.id, String(note || "").trim().slice(0, 500) || null]
  );
  return ins.rows[0] ? { ok: true, id: ins.rows[0].id } : { error: "again" };
}

/** One of the broker's own log rows (for "search again with AI"). */
async function mine(pool, broker, logId) {
  if (!isId(logId)) return null;
  const { rows } = await pool.query("SELECT * FROM search_log WHERE id = $1 AND agency_id = $2 AND broker_id = $3", [logId, broker.agency_id, broker.id]);
  return rows[0] || null;
}

module.exports = { cleanText, record, report, mine, isId };
