// services/chatPlan.js — WhatsApp chat posts → an import plan, through the same planner Excel uses (services/imports.js).
// The parser reads every post first; AI is asked only for a post the parser could not read enough, and only for the
// cells that are still empty. The plan is an "excel" import with source "chat", so the review, row editing, batch fixes,
// duplicate and same-unit checks, apply and undo are one code path for both.
"use strict";

const L = require("../lib/listing");
const AiBlock = require("../lib/aiBlock");
const U = require("../lib/util");
const Places = require("../domain/mapPlaces");
const ChatListing = require("../domain/chatListing");
const Imports = require("./imports");
const ParseLog = require("./chatParseLog");

const MAX_POSTS = 40;
const AI_DEADLINE_MS = 40000;

/** The approved places, indexed for finding a compound inside a post. */
async function loadPlaces(pool) {
  const { rows } = await pool.query("SELECT id, name_en, name_ar, aliases, verified, area_id, subzone_id FROM map_places WHERE approved");
  return { rows, index: Places.buildIndex(rows) };
}

/**
 * @param {Array<{ sender?: string, at?: string, text: string }>} posts at most 40
 * @returns {Promise<{ id: string, posts: number, ai: number, aiBlocked: string|null, counts: object }>}
 */
async function planChat(pool, broker, posts, { AI, ctx, lang = "ar", filename = null } = {}) {
  const list = posts.slice(0, MAX_POSTS);
  const places = await loadPlaces(pool).catch(() => null);
  const logs = [];
  const parsed = list.map((p, i) => {
    const t0 = Date.now();
    const r = ChatListing.parsePost(p.text, places, p);
    logs[i] = { row: i + 1, text: p.text, read: r.read, missing: r.missing, parseMs: Date.now() - t0 };
    return r;
  });
  const cells = parsed.map((r) => ({ ...r.cells }));
  const first = Object.fromEntries(parsed.map((r, i) => [i + 1, { ...r.cells }]));

  // AI only where the parser left a required cell empty, two or three posts at a time, within a time budget.
  const until = Date.now() + AI_DEADLINE_MS;
  const limit = U.createLimiter(3);
  let blocked = null;
  let aiCalls = 0;
  await Promise.all(
    parsed.map((r, i) =>
      limit(async () => {
        if (!r.missing.length || !AI) return;
        if (blocked) return void (logs[i].aiSkipped = blocked);
        if (Date.now() > until) return void (logs[i].aiSkipped = "time");
        const t0 = Date.now();
        aiCalls++;
        logs[i].aiUsed = true;
        try {
          const ex = await L.extractPropertyDetails(AI, { texts: [list[i].text], lang, ctx });
          const filled = ChatListing.fillFromAi(cells[i], ex.fields);
          cells[i] = filled.cells;
          logs[i].aiFilled = filled.filled;
          logs[i].model = ex.modelUsed || null;
        } catch (err) {
          const why = AiBlock.kindOf(err);
          if (why !== "ai") blocked = why;
          logs[i].aiError = why;
        }
        logs[i].aiMs = Date.now() - t0;
      })
    )
  );

  const rows = cells.map((c, i) => ({ rowNumber: i + 1, cells: c }));
  const plan = await Imports.planExcel(pool, broker, { rows, skipped: [] }, { lang, source: "chat" });
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r.cells)))];
  const id = await Imports.savePlan(
    pool,
    broker,
    "excel",
    { ...plan, rows, columns, skipped: [], source: "chat", posts: list.map((p) => ({ sender: p.sender || null, at: p.at || null })), parsed: first, photos: {} },
    { filename }
  );
  await ParseLog.posts(pool, broker, id, logs);
  return { id, posts: list.length, ai: aiCalls, aiBlocked: blocked, counts: plan.counts };
}

module.exports = { planChat, loadPlaces, MAX_POSTS };
