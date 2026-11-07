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
const Q = require("../domain/searchQuery");

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
/**
 * Re-check before "All handled" (Haytham 2026-11-06): the text needs a saved test case, and the quick reader must now read it
 * with no open question (no unsure reasons, no unit question). → { ok, missing: [] } listing what is still missing.
 */
async function recheck(pool, text) {
  const missing = [];
  const { rows: kept } = await pool.query("SELECT query_text, expected FROM search_test_cases WHERE lower(trim(query_text)) = lower(trim($1))", [text]);
  if (!kept.length) missing.push("test_case");
  else if (!runCase(kept[0]).pass) missing.push("rule"); // a rule problem stays open until the rule is fixed and the case passes
  const parsed = Q.fallbackParse(text);
  if (parsed.meta?.reasons?.length || (parsed.meta?.ambiguous || []).length) missing.push("parser");
  return { ok: missing.length === 0, missing };
}

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

const KINDS = ["type", "feature", "place", "furnishing", "finishing", "listing_type"];

/**
 * Corrects a pending word before it is approved: its spelling (term), its kind (type, feature, or place = a compound or
 * area) and what it means (target). → { ok } | { error }
 */
async function editWord(pool, id, { term, kind, target }, { statuses = ["pending"] } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) return { error: "not_found" };
  const t = normalizeSearch(String(term || "")).slice(0, 80);
  const k = KINDS.includes(kind) ? kind : null;
  const g = normalizeSearch(String(target || "")).slice(0, 80);
  if (!t || !k || !g) return { error: "invalid" };
  try {
    const r = await pool.query(
      "UPDATE search_aliases SET term = $2, kind = $3, target = $4, updated_at = now() WHERE id = $1 AND status = ANY($5::text[])",
      [id, t, k, g, statuses]
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

/* ---- Queue, vocabulary and test cases (search review in three tabs) ---- */

const IN_WINDOW = (a, b) => `created_at >= ${a} AND created_at < ${b}`;

/**
 * The work queue: one row per search text, with where it came from (broker reports, nightly findings) and how often.
 * status open = something about it is still open; done = everything about it is closed; type narrows the nightly findings.
 * → { rows: [{ query_text, reports, findings, open_n, last_at, report_id, finding_id }], total }
 */
async function queue(pool, { from, to, status = "open", type = "", q = "", offset = 0, limit = 20 }) {
  const args = [from, to];
  const textLike = q ? `AND s.query_text ILIKE $${args.push(like(q))}` : "";
  const typeSql = TYPES[type] ? `AND ${TYPES[type]}` : "";
  const reportsPart = type
    ? ""
    : `UNION ALL SELECT lower(trim(s.query_text)), r.id::text, 'report', r.created_at, (r.status = 'open'), s.total
         FROM search_reports r JOIN search_log s ON s.id = r.search_log_id WHERE r.created_at >= $1 AND r.created_at < $2 ${textLike}`;
  const having = status === "open" ? "HAVING count(*) FILTER (WHERE is_open) > 0" : status === "done" ? "HAVING count(*) FILTER (WHERE is_open) = 0" : "";
  const { rows } = await pool.query(
    `SELECT k AS query_text, count(*) FILTER (WHERE src = 'report')::int AS reports, count(*) FILTER (WHERE src = 'audit')::int AS findings,
            count(*) FILTER (WHERE is_open)::int AS open_n, max(at) AS last_at, min(total)::int AS total,
            (array_agg(id ORDER BY at DESC) FILTER (WHERE src = 'report'))[1] AS report_id,
            (array_agg(id ORDER BY at DESC) FILTER (WHERE src = 'audit'))[1] AS finding_id,
            count(*) OVER()::int AS n
       FROM (SELECT lower(trim(s.query_text)) AS k, s.id::text AS id, 'audit' AS src, s.created_at AS at, (s.audit_resolved_at IS NULL) AS is_open, s.total
               FROM search_log s WHERE s.created_at >= $1 AND s.created_at < $2 AND ${FLAGGED} ${typeSql} ${textLike}
             ${reportsPart}) x
      WHERE k IS NOT NULL AND k <> ''
      GROUP BY k ${having} ORDER BY open_n DESC, max(at) DESC LIMIT $${args.push(limit)} OFFSET $${args.push(offset)}`,
    args
  );
  return { rows, total: rows[0]?.n || 0 };
}

/** Closes everything open about one search text: reports as fixed or dismissed, nightly findings as handled. */
async function closeText(pool, text, how = "fixed") {
  const rep = await pool.query(
    `UPDATE search_reports r SET status = $2 FROM search_log s WHERE s.id = r.search_log_id AND lower(trim(s.query_text)) = lower(trim($1)) AND r.status = 'open'`,
    [text, how === "dismiss" ? "dismissed" : "fixed"]
  );
  const fin = await resolveText(pool, text);
  return { reports: rep.rowCount, findings: fin };
}

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Runs one test case through the quick reader. A case with expected filters must read them exactly; one without must read with no open question. */
function runCase(c) {
  const parsed = Q.fallbackParse(c.query_text);
  if (c.expected && typeof c.expected === "object") {
    const diffs = Object.keys(c.expected).filter((k) => !sameJson(parsed.filters?.[k], c.expected[k]));
    return { pass: diffs.length === 0, diffs, got: Object.fromEntries(diffs.map((k) => [k, parsed.filters?.[k] ?? null])) };
  }
  const open = Boolean(parsed.meta?.reasons?.length) || (parsed.meta?.ambiguous || []).length > 0;
  return { pass: !open, diffs: open ? ["reading"] : [], got: {} };
}

/** Every kept test case with its pass/fail now (filtered by text, paged). → { rows: [..., pass, diffs, got], total, failing } */
async function casesWithResults(pool, { q = "", offset = 0, limit = 20 }) {
  const base = await cases(pool, { q, offset, limit });
  const ids = base.rows.map((r) => r.id);
  const extra = ids.length ? (await pool.query("SELECT id, expected, note FROM search_test_cases WHERE id = ANY($1::uuid[])", [ids])).rows : [];
  const by = new Map(extra.map((e) => [e.id, e]));
  const rows = base.rows.map((r) => ({ ...r, expected: by.get(r.id)?.expected || null, note: by.get(r.id)?.note || null, ...runCase({ query_text: r.query_text, expected: by.get(r.id)?.expected }) }));
  const all = (await pool.query("SELECT query_text, expected FROM search_test_cases")).rows;
  return { rows, total: base.total, failing: all.filter((c) => !runCase(c).pass).length };
}

/** Keeps a search text as a test case. With expected filters (a rule problem) it fails until the rule is fixed. */
async function addTextCase(pool, text, { expected = null, note = null, ownerId = null } = {}) {
  const t = String(text || "").trim().slice(0, 300);
  if (!t) return { error: "invalid" };
  let exp = null;
  if (expected !== null && expected !== "") {
    try {
      exp = typeof expected === "string" ? JSON.parse(expected) : expected;
    } catch {
      return { error: "bad_json" };
    }
    if (!exp || typeof exp !== "object" || Array.isArray(exp)) return { error: "bad_json" };
  }
  const r = await pool.query(
    `INSERT INTO search_test_cases (query_text, created_by, expected, note) VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (lower(trim(query_text))) DO UPDATE SET expected = COALESCE(EXCLUDED.expected, search_test_cases.expected), note = COALESCE(EXCLUDED.note, search_test_cases.note) RETURNING id`,
    [t, ownerId, exp ? JSON.stringify(exp) : null, note ? String(note).slice(0, 300) : null]
  );
  return { ok: true, id: r.rows[0].id };
}

/**
 * What a new word would change, without saving it: this search's reading before and after, and which test cases would start
 * passing or failing. → { reading_changes, fixes: [text], breaks: [text] }
 */
async function previewWord(pool, { term, target, text }) {
  const t = normalizeSearch(String(term || ""));
  const g = normalizeSearch(String(target || ""));
  if (!t || !g) return { error: "invalid" };
  const approved = (await pool.query("SELECT term, target FROM search_aliases WHERE status = 'approved'")).rows;
  const cs = (await pool.query("SELECT query_text, expected FROM search_test_cases")).rows;
  const evaluate = (list) => {
    Q.setAliases(list);
    return { reading: JSON.stringify(Q.fallbackParse(String(text || "")).filters), cases: cs.map((c) => runCase(c).pass) };
  };
  try {
    const before = evaluate(approved);
    const after = evaluate([...approved, { term: t, target: g }]);
    const fixes = cs.filter((_, i) => !before.cases[i] && after.cases[i]).map((c) => c.query_text);
    const breaks = cs.filter((_, i) => before.cases[i] && !after.cases[i]).map((c) => c.query_text);
    return { reading_changes: before.reading !== after.reading, fixes, breaks };
  } finally {
    Q.setAliases(approved);
  }
}

/** Saves a word the owner taught (approved at once) unless it would break a passing test case. → { ok } | { blocked } | { error } */
async function teachWord(pool, { term, kind, target, text }) {
  const k = KINDS.includes(kind) ? kind : null;
  const t = normalizeSearch(String(term || "")).slice(0, 80);
  const g = normalizeSearch(String(target || "")).slice(0, 80);
  if (!t || !g || !k) return { error: "invalid" };
  const pre = await previewWord(pool, { term: t, target: g, text });
  if (pre.error) return pre;
  if (pre.breaks.length) return { blocked: pre.breaks, ...pre };
  try {
    await pool.query(
      `INSERT INTO search_aliases (term, target, kind, status, source, decided_by, example) VALUES ($1, $2, $3, 'approved', 'manual', 'owner', $4)
       ON CONFLICT (term, target) DO UPDATE SET status = 'approved', kind = EXCLUDED.kind, decided_by = 'owner', updated_at = now()`,
      [t, g, k, String(text || "").slice(0, 200)]
    );
  } catch (err) {
    throw err;
  }
  return { ok: true, ...pre };
}

/** The vocabulary: the AI's pending proposals first, then the approved words. → { rows, total } */
async function vocabulary(pool, { q = "", offset = 0, limit = 20 }) {
  const args = [];
  const w = ["status IN ('pending', 'approved')"];
  if (q) w.push(`(term ILIKE $${args.push(like(q))} OR target ILIKE $${args.length})`);
  const { rows } = await pool.query(
    `SELECT id, term, target, kind, status, source, agreed, example, count(*) OVER()::int AS n FROM search_aliases WHERE ${w.join(" AND ")}
      ORDER BY (status = 'pending') DESC, agreed DESC, term LIMIT $${args.push(limit)} OFFSET $${args.push(offset)}`,
    args
  );
  return { rows, total: rows[0]?.n || 0 };
}

/** Removes an approved word (kept as rejected, so the AI does not propose it again). */
async function removeWord(pool, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) return false;
  const r = await pool.query("UPDATE search_aliases SET status = 'rejected', decided_by = 'owner', updated_at = now() WHERE id = $1 AND status = 'approved'", [id]);
  return r.rowCount > 0;
}

module.exports = { TYPES, KINDS, windowOf, summary, reports, findings, repeats, queue, closeText, runCase, casesWithResults, addTextCase, previewWord, teachWord, vocabulary, removeWord, decideReport, decideFinding, recheck, resolveText, addCase, cases, removeCase, editWord };
