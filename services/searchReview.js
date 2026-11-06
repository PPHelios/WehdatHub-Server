// services/searchReview.js — The CRM owner's search review: figures for a period, and the work queue (reports, nightly
// findings, repeat offenders) with filters and paging. Owner only; the route checks.
"use strict";

const FLAGGED = `s.audit IS NOT NULL AND (s.audit->>'zero' = 'true' OR jsonb_array_length(s.audit->'bad_ids') > 0 OR jsonb_array_length(s.audit->'disagree') > 0 OR jsonb_array_length(s.audit->'missed_ids') > 0)`;
const TYPES = {
  zero: `s.audit->>'zero' = 'true'`,
  wrong: `jsonb_array_length(s.audit->'bad_ids') > 0`,
  differ: `jsonb_array_length(s.audit->'disagree') > 0`,
  missed: `jsonb_array_length(s.audit->'missed_ids') > 0`
};
const { normalizeSearch } = require("../domain/searchText");

const DAY = 24 * 3600 * 1000;

/** The time window a list uses: the period, or just the last 24 hours when the "changed in the last day" filter is on. */
const windowOf = (p, changed, now = new Date()) => (changed ? { from: new Date(now.getTime() - DAY), to: now } : { from: p.from, to: p.to });

async function figures(pool, from, to) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS searches, count(*) FILTER (WHERE s.total = 0)::int AS zero, count(*) FILTER (WHERE ${FLAGGED})::int AS flagged
       FROM search_log s WHERE s.created_at >= $1 AND s.created_at < $2`,
    [from, to]
  );
  const rep = await pool.query("SELECT count(*)::int AS n FROM search_reports WHERE created_at >= $1 AND created_at < $2", [from, to]);
  return { ...rows[0], reports: rep.rows[0].n };
}

/** The period's figures, the one before it, when the nightly check last ran, and what waits for the owner. */
async function summary(pool, p) {
  const [now, before, last, open] = await Promise.all([
    figures(pool, p.from, p.to),
    figures(pool, p.prevFrom, p.prevTo),
    pool.query("SELECT max(created_at) AS at FROM search_log WHERE audit IS NOT NULL").then((x) => x.rows[0].at),
    pool
      .query(
        `SELECT (SELECT count(*) FROM search_aliases WHERE status = 'pending')::int AS words,
                (SELECT count(*) FROM search_reports WHERE status = 'open')::int AS reports,
                (SELECT count(*) FROM search_log s WHERE ${FLAGGED} AND s.audit_resolved_at IS NULL)::int AS audit`
      )
      .then((x) => x.rows[0])
  ]);
  return { now, before, lastChecked: last, open };
}

const like = (q) => `%${String(q).replace(/[\\%_]/g, "\\$&")}%`;

/** "Wrong search" reports in the window (status open | done | all). → { rows, total } */
async function reports(pool, { from, to, status = "open", q = "", offset = 0, limit = 20 }) {
  const w = ["r.created_at >= $1", "r.created_at < $2"];
  const args = [from, to];
  if (status === "open") w.push("r.status = 'open'");
  else if (status === "done") w.push("r.status <> 'open'");
  if (q) w.push(`s.query_text ILIKE $${args.push(like(q))}`);
  const { rows } = await pool.query(
    `SELECT r.id, r.note, r.status, r.created_at, s.query_text, s.source, s.local_filters, s.ai_filters, s.used_filters, s.total, count(*) OVER()::int AS n
       FROM search_reports r JOIN search_log s ON s.id = r.search_log_id WHERE ${w.join(" AND ")} ORDER BY r.created_at DESC LIMIT $${args.push(limit)} OFFSET $${args.push(offset)}`,
    args
  );
  return { rows, total: rows[0]?.n || 0 };
}

/** Nightly findings in the window (status open | done | all; type zero | wrong | differ | missed). → { rows, total } */
async function findings(pool, { from, to, status = "open", type = "", q = "", offset = 0, limit = 20 }) {
  const w = ["s.created_at >= $1", "s.created_at < $2", FLAGGED];
  const args = [from, to];
  if (status === "open") w.push("s.audit_resolved_at IS NULL");
  else if (status === "done") w.push("s.audit_resolved_at IS NOT NULL");
  if (TYPES[type]) w.push(TYPES[type]);
  if (q) w.push(`s.query_text ILIKE $${args.push(like(q))}`);
  const { rows } = await pool.query(
    `SELECT s.id, s.query_text, s.total, s.audit, s.audit_resolved_at, s.created_at, count(*) OVER()::int AS n
       FROM search_log s WHERE ${w.join(" AND ")} ORDER BY s.created_at DESC LIMIT $${args.push(limit)} OFFSET $${args.push(offset)}`,
    args
  );
  return { rows, total: rows[0]?.n || 0 };
}

/** The same search flagged again and again, worst first. → { rows: [{ query_text, times, last_at }], total } */
async function repeats(pool, { from, to, q = "", offset = 0, limit = 20 }) {
  const w = ["s.created_at >= $1", "s.created_at < $2", FLAGGED, "s.audit_resolved_at IS NULL"];
  const args = [from, to];
  if (q) w.push(`s.query_text ILIKE $${args.push(like(q))}`);
  const { rows } = await pool.query(
    `SELECT lower(trim(s.query_text)) AS query_text, count(*)::int AS times, max(s.created_at) AS last_at, count(*) OVER()::int AS n
       FROM search_log s WHERE ${w.join(" AND ")} GROUP BY 1 HAVING count(*) > 1 ORDER BY times DESC, last_at DESC LIMIT $${args.push(limit)} OFFSET $${args.push(offset)}`,
    args
  );
  return { rows, total: rows[0]?.n || 0 };
}

/** Closes a report as fixed or dismissed (or reopens it). */
async function decideReport(pool, id, decision) {
  const status = { fixed: "fixed", dismiss: "dismissed", reopen: "open" }[decision];
  if (!status) return false;
  const r = await pool.query("UPDATE search_reports SET status = $2 WHERE id = $1", [id, status]);
  return r.rowCount > 0;
}

/** Marks a nightly finding handled (or reopens it). */
async function decideFinding(pool, id, decision) {
  if (!["resolve", "reopen"].includes(decision)) return false;
  const r = await pool.query(`UPDATE search_log SET audit_resolved_at = ${decision === "resolve" ? "now()" : "NULL"} WHERE id = $1 AND audit IS NOT NULL`, [id]);
  return r.rowCount > 0;
}

/** Resolves every open finding of one search text at once (a repeat offender fixed). */
async function resolveText(pool, text) {
  const r = await pool.query(`UPDATE search_log s SET audit_resolved_at = now() WHERE lower(trim(s.query_text)) = lower(trim($1)) AND s.audit_resolved_at IS NULL AND ${FLAGGED}`, [text]);
  return r.rowCount;
}

/** Keeps a finding's search text as a test case (once per text). → true when added, false when it already was one or missing. */
async function addCase(pool, logId, ownerId) {
  const { rows } = await pool.query("SELECT query_text FROM search_log WHERE id = $1", [logId]);
  if (!rows[0]) return false;
  const r = await pool.query(
    "INSERT INTO search_test_cases (query_text, source_log_id, created_by) VALUES ($1, $2, $3) ON CONFLICT (lower(trim(query_text))) DO NOTHING",
    [rows[0].query_text, logId, ownerId || null]
  );
  return r.rowCount > 0;
}

/** The kept test cases, newest first, filtered by text. → { rows, total } */
async function cases(pool, { q = "", offset = 0, limit = 20 }) {
  const w = ["TRUE"];
  const args = [];
  if (q) w.push(`query_text ILIKE $${args.push(like(q))}`);
  const { rows } = await pool.query(
    `SELECT id, query_text, created_at, count(*) OVER()::int AS n FROM search_test_cases WHERE ${w.join(" AND ")} ORDER BY created_at DESC LIMIT $${args.push(limit)} OFFSET $${args.push(offset)}`,
    args
  );
  return { rows, total: rows[0]?.n || 0 };
}

const KINDS = ["type", "feature", "place"];

/**
 * Corrects a pending word before it is approved: its spelling (term), its kind (type, feature, or place = a compound or
 * area) and what it means (target). → { ok } | { error }
 */
async function editWord(pool, id, { term, kind, target }) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) return { error: "not_found" };
  const t = normalizeSearch(String(term || "")).slice(0, 80);
  const k = KINDS.includes(kind) ? kind : null;
  const g = normalizeSearch(String(target || "")).slice(0, 80);
  if (!t || !k || !g) return { error: "invalid" };
  try {
    const r = await pool.query(
      "UPDATE search_aliases SET term = $2, kind = $3, target = $4, updated_at = now() WHERE id = $1 AND status = 'pending'",
      [id, t, k, g]
    );
    return r.rowCount ? { ok: true } : { error: "not_found" };
  } catch (err) {
    if (err.code === "23505") return { error: "duplicate" };
    throw err;
  }
}

/** Removes a test case. */
async function removeCase(pool, id) {
  const r = await pool.query("DELETE FROM search_test_cases WHERE id = $1", [id]);
  return r.rowCount > 0;
}

module.exports = { TYPES, windowOf, summary, reports, findings, repeats, decideReport, decideFinding, resolveText, addCase, cases, removeCase, editWord };
