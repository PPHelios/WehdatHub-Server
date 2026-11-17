// scripts/parser-report.js — The weekly one-page parser agreement report (Parser consolidation, Phase 5).
// Usage: node --env-file=.env scripts/parser-report.js [days=7]     (read-only; field names and counts only)
"use strict";

const { createPool } = require("../lib/db");
const { renderReport } = require("../domain/parserReport");

(async () => {
  const days = Number(process.argv[2]) || 7;
  const pool = createPool();
  try {
    const since = new Date(Date.now() - days * 864e5);
    const { rows: reads } = await pool.query("SELECT status, metadata FROM operation_logs WHERE operation_type = 'parser_read' AND created_at >= $1", [since]);
    const { rows: search } = await pool.query("SELECT source, disagree FROM search_log WHERE created_at >= $1", [since]);
    console.log(renderReport({ days, reads, search }));
  } finally {
    await pool.end();
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
