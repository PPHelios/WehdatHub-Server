// services/parserLog.js — One shared log row for every text parser (Parser consolidation, section 7a of the plan).
// A `parser_read` row in operation_logs (no new table): which parser, what kind of input, the masked text, the fields it
// read, the ones it left empty or was unsure of, how long it took, and (when an AI result exists) which fields agreed
// or differed. Field names only for agreement, never values. Never throws and never blocks the request.
"use strict";

const { logOperation } = require("../lib/db");
const { parsePost, compareWithAi, mask } = require("../domain/chatListing");

/**
 * Runs the rules-only post parser on the same text the AI read and compares the two, for the log.
 * @returns {{ cells: object, read: string[], missing: string[], agree: string[], differ: string[], ms: number }|null}
 */
function readAlongside(text, aiFields = null) {
  try {
    const t0 = Date.now();
    const post = parsePost(String(text || ""));
    const cmp = aiFields ? compareWithAi(post.cells, aiFields) : { agree: [], differ: [] };
    return { cells: post.cells, read: post.read || Object.keys(post.cells), missing: post.missing || [], agree: cmp.agree, differ: cmp.differ, ms: Date.now() - t0 };
  } catch {
    return null;
  }
}

/** Writes the row. `pool` is the app's pool; extra metadata is merged in (names only, no private values). */
function logParserRead(pool, { agency_id, broker_id = null, parser, kind, text = "", result = null, status = "ok", extra = {} } = {}) {
  try {
    if (!pool || !agency_id || !parser) return;
    const r = result || {};
    const p = logOperation(pool, {
      agency_id,
      broker_id,
      operation_type: "parser_read",
      status,
      total_duration_ms: r.ms ?? null,
      metadata: {
        parser,
        kind,
        text: mask(text),
        read: r.read || [],
        empty: r.missing || [],
        unsure: r.unsure || [],
        agree: r.agree || [],
        differ: r.differ || [],
        ...extra,
      },
    });
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {
    /* logging never breaks a request */
  }
}

module.exports = { readAlongside, logParserRead };
