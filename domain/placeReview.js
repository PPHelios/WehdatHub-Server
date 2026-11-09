// domain/placeReview.js — Pure rules for the owner's review of new places: which pending names are the same thing, and
// which existing places or areas they look like. It only suggests; the owner decides every merge.
"use strict";

const { placeKey, keysOf, dice } = require("./mapPlaces");

const SAME = 0.8; // two pending names this alike are shown as one group
const LOOKS_LIKE = 0.6; // an existing place this alike is offered as a possible duplicate

/** The best likeness between two rows' names and aliases, 0 to 1 (1 = a name or alias is identical once noise words go). */
function likeness(a, b) {
  let best = 0;
  for (const x of keysOf(a)) for (const y of keysOf(b)) best = Math.max(best, x === y ? 1 : dice(x, y));
  return best;
}

/**
 * Pending names grouped, each group with the existing places or areas it may duplicate.
 * @param {Array<{kind: "compound"|"area", id: string, name_en?: string, name_ar?: string, times_seen?: number}>} pending
 * @param {Array<{kind: "compound"|"area"|"subzone", id: string, name_en?: string, name_ar?: string, aliases?: string[], path?: string}>} existing approved rows
 * @returns {Array<{kind: string, lead: object, items: object[], times_seen: number, matches: Array<{kind: string, id: string, name: string, path: string, score: number, exact: boolean}>}>}
 */
function groupPending(pending, existing) {
  const parent = pending.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < pending.length; i++) {
    for (let j = i + 1; j < pending.length; j++) {
      if (pending[i].kind === pending[j].kind && likeness(pending[i], pending[j]) >= SAME) parent[find(j)] = find(i);
    }
  }
  const groups = new Map();
  pending.forEach((item, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) || []), item]);
  });
  return [...groups.values()]
    .map((items) => {
      const sorted = [...items].sort((a, b) => (b.times_seen || 1) - (a.times_seen || 1));
      const lead = sorted[0];
      const pool = existing.filter((e) => (lead.kind === "compound" ? e.kind === "compound" : e.kind !== "compound"));
      const matches = [];
      for (const e of pool) {
        const score = Math.max(...items.map((it) => likeness(it, e)));
        if (score >= LOOKS_LIKE) matches.push({ kind: e.kind, id: e.id, name: e.name_en || e.name_ar, path: e.path || "", score: Math.round(score * 100) / 100, exact: score === 1 });
      }
      matches.sort((a, b) => b.score - a.score);
      return { kind: lead.kind, lead, items: sorted, times_seen: items.reduce((n, it) => n + (it.times_seen || 1), 0), matches: matches.slice(0, 3) };
    })
    .sort((a, b) => b.times_seen - a.times_seen);
}

module.exports = { groupPending, likeness, placeKey };
