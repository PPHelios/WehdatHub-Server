// services/chatPlan.js — WhatsApp chat posts → an import plan, through the same planner Excel uses (services/imports.js).
// The parser reads every post (rules only, no AI). The plan is an "excel" import with source "chat", so the review, row editing, batch fixes,
// duplicate and same-unit checks, apply and undo are one code path for both.
"use strict";

const Places = require("../domain/mapPlaces");
const ChatListing = require("../domain/chatListing");
const Imports = require("./imports");
const ParseLog = require("./chatParseLog");
const Cells = require("../domain/importEditorCells");

const MAX_POSTS = 40;

/** The approved places, indexed for finding a compound inside a post. */
async function loadPlaces(pool) {
  const { rows } = await pool.query("SELECT id, name_en, name_ar, aliases, verified, area_id, subzone_id FROM map_places WHERE approved");
  return { rows, index: Places.buildIndex(rows) };
}

/**
 * @param {Array<{ sender?: string, at?: string, text: string }>} posts at most 40
 * @returns {Promise<{ id: string, posts: number, ai: number, aiBlocked: string|null, counts: object }>}
 */
async function planChat(pool, broker, posts, { lang = "ar", filename = null } = {}) {
  const list = posts.slice(0, MAX_POSTS);
  const places = await loadPlaces(pool).catch(() => null);
  const logs = [];
  const parsed = list.map((p, i) => {
    const t0 = Date.now();
    const r = ChatListing.parsePost(p.text, places, p);
    logs[i] = { row: i + 1, text: p.text, read: r.read, missing: r.missing, suspect: r.suspect, parseMs: Date.now() - t0, ...(r.missing.length ? { aiSkipped: "rules_only" } : {}) };
    return r;
  });
  const areas = list.some((p) => p.fields) ? await require("./areas").approvedAreas(pool).catch(() => []) : [];
  const cells = parsed.map((r, i) => Cells.mergeEdits(r.cells, list[i].fields || null, { areas }));
  const newPlaces = {};
  list.forEach((p, i) => { const np = p.fields && Cells.newPlaceOf(p.fields); if (np) newPlaces[i + 1] = np; });
  const first = Object.fromEntries(parsed.map((r, i) => [i + 1, { ...r.cells }]));

  // Rules only (Parser consolidation, Phase 6): no AI call. What the parser cannot read stays empty and is completed in the Edit window.
  const aiCalls = 0;
  const blocked = null;

  const rows = cells.map((c, i) => ({ rowNumber: i + 1, cells: c }));
  const plan = await Imports.planExcel(pool, broker, { rows, skipped: [] }, { lang, source: "chat" });
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r.cells)))];
  const id = await Imports.savePlan(
    pool,
    broker,
    "excel",
    { ...plan, rows, columns, skipped: [], source: "chat", posts: list.map((p) => ({ sender: p.sender || null, at: p.at || null, text: String(p.text || '').slice(0, 4000), orig: String(p.orig || '').slice(0, 4000) })), parsed: first, photos: {}, newPlaces },
    { filename }
  );
  await ParseLog.posts(pool, broker, id, logs);
  return { id, posts: list.length, ai: aiCalls, aiBlocked: blocked, counts: plan.counts };
}

module.exports = { planChat, loadPlaces, MAX_POSTS };
