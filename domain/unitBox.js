// domain/unitBox.js — The one box for where a unit is and what it has (pure). What a broker types or pastes becomes one place
// (a compound, a sub-zone or an area) and feature keys from the dictionary. The website, the app and the Telegram draft call
// these same rules (docs/plans/unified-unit-box.md), so none keeps its own copy.
"use strict";

const Features = require("./features");
const A = require("./areas");
const { placeKey, keysOf } = require("./mapPlaces");

// A place key shorter than this is not looked for inside free text: short names ("Oia", "June") are ordinary words too.
const MIN_KEY = 4;
const MAX_WORDS = 6;
const RANK = { compound: 0, subzone: 1, area: 2 };

/** Features whose label or a match word starts with (or holds) the typed text: [{kind: "feature", key, label}]. */
function suggestFeatures(text, lang = "ar", limit = 6) {
  const q = Features.normalizeForMatch(text);
  if (q.length < 2) return [];
  const out = [];
  for (const f of Features.FEATURES) {
    const words = [f.ar, f.en, ...f.syn].map(Features.normalizeForMatch).filter(Boolean);
    const score = words.some((w) => w === q) ? 3 : words.some((w) => w.startsWith(q) || w.split(" ").some((p) => p.startsWith(q))) ? 2 : words.some((w) => w.includes(q)) ? 1 : 0;
    if (score) out.push({ kind: "feature", key: f.key, label: lang === "en" ? f.en : f.ar, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit).map(({ score, ...rest }) => rest);
}

/**
 * The one place named inside free text, or null: the longest compound, sub-zone or area name or alias found as whole words
 * (a compound wins over an area of the same length). Words that are part of a feature ("فيو النادي") are not places.
 * Shaped like a suggestion (domain/areas.js suggest): {kind, id, label, path, area_id, subzone_id, ...}.
 */
function findPlace(text, { places = [], areas = [] }, lang = "ar") {
  const rows = [...places.map((p) => ({ kind: "compound", row: p })), ...areas.map((a) => ({ kind: a.parent_id ? "subzone" : "area", row: a }))];
  const byKey = new Map();
  for (const r of rows) {
    for (const k of keysOf(r.row)) {
      if (k.length < MIN_KEY) continue;
      const cur = byKey.get(k);
      if (!cur || RANK[r.kind] < RANK[cur.kind]) byKey.set(k, r);
    }
  }
  let hay = ` ${placeKey(text)} `;
  for (const key of Features.matchFeatureKeys(text)) {
    for (const s of Features.FEATURES.find((f) => f.key === key).syn) hay = hay.split(` ${placeKey(s)} `).join(" ");
  }
  const words = hay.trim().split(" ").filter(Boolean);
  let best = null;
  for (let n = Math.min(MAX_WORDS, words.length); n >= 1 && !best; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const hit = byKey.get(words.slice(i, i + n).join(" "));
      if (hit && (!best || RANK[hit.kind] < RANK[best.kind])) best = hit;
    }
  }
  if (!best) return null;
  const name = lang === "ar" ? best.row.name_ar || best.row.name_en : best.row.name_en || best.row.name_ar;
  return A.suggest(name, { places, areas }, 20, lang).find((s) => s.id === best.row.id) || null;
}

/** Text → { place, features }: what the box shows as chips for a pasted message. Nothing is invented. */
function resolve(text, lists, lang = "ar") {
  const s = String(text || "").slice(0, 4000);
  return { place: findPlace(s, lists, lang), features: Features.matchFeatureKeys(s) };
}

module.exports = { suggestFeatures, findPlace, resolve };
