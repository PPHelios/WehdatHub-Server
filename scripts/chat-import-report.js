// scripts/chat-import-report.js — Prints the WhatsApp import summary (web and app): parser vs AI, corrections, timings, errors, app use.
// Usage: node --env-file=.env scripts/chat-import-report.js [days=30] [agency-uuid]
"use strict";

const { createPool } = require("../lib/db");
const { report } = require("../services/chatImportReport");

(async () => {
  const days = Number(process.argv[2]) || 30;
  const agencyId = process.argv[3] || null;
  const pool = createPool();
  try {
    console.log(JSON.stringify(await report(pool, { days, agencyId }), null, 2));
  } finally {
    await pool.end();
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
