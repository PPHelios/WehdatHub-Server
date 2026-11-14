// services/chatParseLog.js — Logs for the chat import: what the parser read from each post and whether AI was needed (to
// track its quality and replace AI step by step, like the search log), what the person corrected in the review, and the
// time and outcome of each step. Rows go to operation_logs (90 days, then rolled up). Logging never breaks an import.
"use strict";

const { logOperation } = require("../lib/db");
const { mask } = require("../domain/chatListing");

const safe = (p) => p.catch((err) => console.warn("Chat import log failed:", err.message));

/** One row per post: the parser's reading, what AI added, how long each took. */
function posts(pool, broker, importId, list) {
  return Promise.all(
    list.map((e) =>
      safe(
        logOperation(pool, {
          agency_id: broker.agency_id,
          broker_id: broker.id,
          operation_type: "chat_parse",
          status: e.aiError ? "error" : "ok",
          error_code: e.aiError || null,
          total_duration_ms: Math.round((e.parseMs || 0) + (e.aiMs || 0)),
          gemini_ms: e.aiMs ? Math.round(e.aiMs) : null,
          model_used: e.model || null,
          metadata: { import_id: importId, row: e.row, text: mask(e.text), read: e.read, missing: e.missing, ai_used: Boolean(e.aiUsed), ai_filled: e.aiFilled || [], ai_skipped: e.aiSkipped || null }
        })
      )
    )
  );
}

/** At apply: for each applied row, the cells the person changed in the review (a miss the parser should learn). */
function applied(pool, broker, importId, payload, wanted, ms) {
  const items = payload.items || [];
  const rows = new Map((payload.rows || []).map((r) => [r.rowNumber, r.cells || {}]));
  const parsed = payload.parsed || {};
  const out = [];
  for (const item of items) {
    if (!wanted.has(item.row)) continue;
    const now = rows.get(item.row) || {};
    const first = parsed[item.row] || {};
    const edited = [...new Set([...Object.keys(now), ...Object.keys(first)])].filter((k) => !["description", "notes"].includes(k) && String(now[k] ?? "") !== String(first[k] ?? ""));
    out.push({ row: item.row, kind: item.kind, edited });
  }
  return safe(
    logOperation(pool, {
      agency_id: broker.agency_id,
      broker_id: broker.id,
      operation_type: "chat_import_apply",
      status: "ok",
      total_duration_ms: Math.round(ms || 0),
      metadata: { import_id: importId, rows: out.length, edited: out.filter((o) => o.edited.length).length, detail: out.slice(0, 60) }
    })
  );
}

/** Steps run in the browser (read zip, match, shrink, upload): time, outcome and the error text shown to the person. */
function steps(pool, broker, list) {
  return Promise.all(
    list.slice(0, 20).map((s) =>
      safe(
        logOperation(pool, {
          agency_id: broker.agency_id,
          broker_id: broker.id,
          operation_type: "chat_import_step",
          status: s.ok ? "ok" : "error",
          error_code: s.ok ? null : String(s.error || "failed").slice(0, 60),
          total_duration_ms: Math.max(0, Math.round(Number(s.ms) || 0)),
          metadata: { step: String(s.step || "").slice(0, 30), ...(s.meta && typeof s.meta === "object" ? Object.fromEntries(Object.entries(s.meta).filter(([, v]) => ["number", "boolean"].includes(typeof v) || (typeof v === "string" && v.length <= 40))) : {}) }
        })
      )
    )
  );
}

module.exports = { posts, applied, steps };
