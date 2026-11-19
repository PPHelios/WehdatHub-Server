// services/chatDecisions.js — What the agency decided about each post of a WhatsApp chat (saved, discarded, unchanged), kept per chat
// fingerprint so importing the same chat again (website or app, any broker) does not ask the same questions. Posts are told apart by
// domain/chatFingerprint.js, the same ids on every client.
"use strict";

const FP = require("../domain/chatFingerprint");

const OUTCOMES = ["saved", "discarded", "unchanged"];
const MAX_PER_CHAT = 5000;
const MAX_PER_REQUEST = 200;

/** @returns {Promise<{ decisions: Record<string, { outcome: string, at: string }>, last_import_at: string|null }>} */
async function list(pool, agencyId, chatFp) {
  if (!FP.isChatFp(chatFp)) return { decisions: {}, last_import_at: null };
  const { rows } = await pool.query("SELECT post_fp, outcome, updated_at FROM chat_import_decisions WHERE agency_id = $1 AND chat_fp = $2 ORDER BY updated_at DESC LIMIT $3", [agencyId, chatFp, MAX_PER_CHAT]);
  const decisions = {};
  let last = null;
  for (const r of rows) {
    decisions[r.post_fp] = { outcome: r.outcome, at: new Date(r.updated_at).toISOString() };
    if (r.outcome === "saved" && !last) last = new Date(r.updated_at).toISOString();
  }
  return { decisions, last_import_at: last };
}

/** Upserts decisions ({ post_fp, outcome }, up to 200), then prunes the oldest beyond 5000 for the chat. Returns how many were stored. */
async function record(pool, agencyId, brokerId, chatFp, items) {
  if (!FP.isChatFp(chatFp)) return 0;
  const seen = new Map();
  for (const it of Array.isArray(items) ? items.slice(0, MAX_PER_REQUEST) : []) {
    const post = String(it?.post_fp || "");
    if (FP.isPostFp(post) && OUTCOMES.includes(it?.outcome)) seen.set(post, it.outcome);
  }
  if (!seen.size) return 0;
  const posts = [...seen.keys()];
  await pool.query(
    `INSERT INTO chat_import_decisions (agency_id, broker_id, chat_fp, post_fp, outcome, updated_at)
     SELECT $1, $2, $3, p, o, NOW() FROM unnest($4::text[], $5::text[]) AS t(p, o)
     ON CONFLICT (agency_id, chat_fp, post_fp) DO UPDATE SET outcome = EXCLUDED.outcome, broker_id = EXCLUDED.broker_id, updated_at = NOW()`,
    [agencyId, brokerId || null, chatFp, posts, posts.map((p) => seen.get(p))]
  );
  await pool.query(
    `DELETE FROM chat_import_decisions WHERE agency_id = $1 AND chat_fp = $2 AND post_fp IN (
       SELECT post_fp FROM chat_import_decisions WHERE agency_id = $1 AND chat_fp = $2 ORDER BY updated_at DESC, post_fp OFFSET $3)`,
    [agencyId, chatFp, MAX_PER_CHAT]
  );
  return posts.length;
}

/** Forgets specific posts' decisions (restore), or every decision of the chat when postFps is empty ("forget this chat"). Returns the rows removed. */
async function forget(pool, agencyId, chatFp, postFps = null) {
  if (!FP.isChatFp(chatFp)) return 0;
  const some = Array.isArray(postFps) && postFps.length ? postFps.slice(0, MAX_PER_REQUEST * 5).map(String).filter(FP.isPostFp) : null;
  if (Array.isArray(postFps) && postFps.length && !some.length) return 0;
  const { rowCount } = some
    ? await pool.query("DELETE FROM chat_import_decisions WHERE agency_id = $1 AND chat_fp = $2 AND post_fp = ANY($3::text[])", [agencyId, chatFp, some])
    : await pool.query("DELETE FROM chat_import_decisions WHERE agency_id = $1 AND chat_fp = $2", [agencyId, chatFp]);
  return rowCount;
}

module.exports = { list, record, forget, OUTCOMES, MAX_PER_CHAT, MAX_PER_REQUEST };
