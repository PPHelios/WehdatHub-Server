// scripts/assistant-misses.js — What the Ask assistant missed (thumbs-down and "didn't get that"), grouped by question.
// Usage: node --env-file=.env scripts/assistant-misses.js [--days 7] [--agency <id>]
// Questions are already scrubbed (no phones or emails). Add the useful ones to tests/fixtures/assistant-questions.json.
"use strict";

const { createPool } = require("../lib/db");

/** Same wording, different case, spacing or punctuation -> one line. */
const normalize = (q) => String(q || "").toLowerCase().replace(/[^\p{L}\p{N}#@\s]/gu, " ").replace(/\s+/g, " ").trim();

async function misses(pool, { days = 7, agency = null } = {}) {
  const { rows } = await pool.query(
    "SELECT question, verdict, reason, created_at FROM assistant_feedback WHERE created_at >= NOW() - make_interval(days => $1::int) AND ($2::uuid IS NULL OR agency_id = $2) ORDER BY created_at DESC",
    [days, agency]
  );
  const groups = new Map();
  for (const r of rows) {
    const key = normalize(r.question);
    const g = groups.get(key) || { question: r.question, count: 0, down: 0, clarify: 0, reasons: new Set(), last: r.created_at };
    g.count++;
    g[r.verdict]++;
    if (r.reason) g.reasons.add(r.reason);
    groups.set(key, g);
  }
  return [...groups.values()]; // rows are newest first, so Map order is newest first
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const pool = createPool();
  try {
    const list = await misses(pool, { days: Math.max(1, parseInt(opt("--days", "7"), 10) || 7), agency: opt("--agency") });
    if (!list.length) return console.log("No misses.");
    for (const g of list) console.log(`${String(g.count).padStart(3)}x  down:${g.down} clarify:${g.clarify}  ${[...g.reasons].join(",") || "-"}  ${new Date(g.last).toISOString().slice(0, 10)}  ${g.question}`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

module.exports = { misses, normalize };
