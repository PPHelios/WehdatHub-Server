// services/searchLearn.js — The parser learns from the AI. When the quick reader left exactly one word unused and the AI's
// reading added exactly one thing (a place, a type or a feature), that word is proposed as an alias of it. Proposals wait
// for the CRM owner; after the first month of searches, one the AI agreed on five or more times is approved on its own.
"use strict";

const Places = require("../domain/places");
const Features = require("../domain/features");
const { TYPE_TERMS } = require("../domain/vocabulary");
const { normalizeSearch } = require("../domain/searchText");
const Vocab = require("./searchVocab");

const AUTO_AGREED = 5;
const AUTO_AFTER_DAYS = 30;

const placeKey = (p) => (typeof p === "string" ? p : `${p?.kind}:${p?.key}`);

/** What the AI read that the quick reader did not: [{ kind, target }] (target = a word the dictionaries know). */
function addedByAi(local, ai) {
  const added = [];
  const lp = new Set((local.places || []).map(placeKey));
  for (const p of ai.places || []) {
    if (lp.has(placeKey(p))) continue;
    const name = typeof p === "object" ? Places.placeName(p) : null;
    if (name?.ar) added.push({ kind: "place", target: normalizeSearch(name.ar) });
  }
  const lt = new Set(local.property_types || []);
  for (const t of ai.property_types || []) {
    if (lt.has(t) || !TYPE_TERMS[t]) continue;
    added.push({ kind: "type", target: normalizeSearch(TYPE_TERMS[t][0]) });
  }
  const lf = new Set(local.features || []);
  for (const k of ai.features || []) {
    if (lf.has(k)) continue;
    const f = Features.FEATURES.find((x) => x.key === k);
    if (f) added.push({ kind: "feature", target: normalizeSearch(f.ar) });
  }
  return added;
}

/**
 * Proposes an alias from one search where both readings exist. → the proposal { term, target, kind } or null.
 */
async function learn(pool, { text = "", local, ai }) {
  try {
    if (!local?.filters || !ai?.filters) return null;
    const words = (local.meta?.leftover || []).filter((w) => w.length >= 3 && !/\d/.test(w));
    const added = addedByAi(local.filters, ai.filters);
    if (words.length !== 1 || added.length !== 1) return null;
    const term = normalizeSearch(words[0]);
    const { kind, target } = added[0];
    if (!term || term === target) return null;
    await pool.query(
      `INSERT INTO search_aliases (term, target, kind, example) VALUES ($1, $2, $3, $4)
       ON CONFLICT (term, target) DO UPDATE SET agreed = search_aliases.agreed + 1, updated_at = now()
        WHERE search_aliases.status = 'pending'`,
      [term, target, kind, String(text).slice(0, 200)]
    );
    return { term, target, kind };
  } catch (err) {
    console.warn("Search learning failed:", err.message);
    return null;
  }
}

/** Pending proposals, most agreed first. */
async function pending(pool, limit = 50) {
  const { rows } = await pool.query("SELECT * FROM search_aliases WHERE status = 'pending' ORDER BY agreed DESC, created_at LIMIT $1", [limit]);
  return rows;
}

/** The owner's decision on one proposal. → { ok } | { error: "not_found" } */
async function decide(pool, id, approve) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) return { error: "not_found" };
  const { rows } = await pool.query(
    "UPDATE search_aliases SET status = $2, decided_by = 'owner', updated_at = now() WHERE id = $1 AND status = 'pending' RETURNING id",
    [id, approve ? "approved" : "rejected"]
  );
  if (!rows[0]) return { error: "not_found" };
  Vocab.reset();
  await Vocab.refresh(pool);
  return { ok: true };
}

/** After the first month of searches, proposals the AI agreed on 5+ times are approved. → how many. */
async function autoApprove(pool, now = new Date()) {
  const { rows } = await pool.query(
    `UPDATE search_aliases SET status = 'approved', decided_by = 'auto', updated_at = now()
      WHERE status = 'pending' AND source = 'ai' AND agreed >= $1
        AND (SELECT MIN(created_at) FROM search_log) <= $2::timestamptz - make_interval(days => $3)
      RETURNING id`,
    [AUTO_AGREED, now.toISOString(), AUTO_AFTER_DAYS]
  );
  if (rows.length) {
    Vocab.reset();
    await Vocab.refresh(pool);
  }
  return rows.length;
}

module.exports = { AUTO_AGREED, AUTO_AFTER_DAYS, addedByAi, learn, pending, decide, autoApprove };
