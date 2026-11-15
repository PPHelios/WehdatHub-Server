// services/placeSuggest.js — One suggestion list for what a person types in a place box: compounds, their aliases, areas
// and sub-zones together (rules in domain/areas.js). The approved lists are cached for a minute.
"use strict";

const crypto = require("crypto");
const A = require("../domain/areas");
const { placeKey, keysOf } = require("../domain/mapPlaces");
const UnitBox = require("../domain/unitBox");
const Features = require("../domain/features");
const Areas = require("./areas");

const CACHE_MS = 60 * 1000;
let cache = { at: 0, places: [], areas: [], zones: [], version: "" };

/** The feature dictionary for the phone: strict synonyms (syn), as the unit box matches them. */
const featureList = () => Features.FEATURES.map(({ key, ar, en, group, syn }) => ({ key, ar, en, group, syn }));

async function lists(pool) {
  if (Date.now() - cache.at < CACHE_MS) return cache;
  const [places, areas, zones] = await Promise.all([
    pool.query("SELECT id, name_en, name_ar, aliases, area_id, subzone_id, lat, lng FROM map_places WHERE approved"),
    Areas.approvedAreas(pool),
    pool.query("SELECT place_id, area_id FROM place_zones").then((r) => r.rows).catch(() => [])
  ]);
  // The version changes only when an approved place, an area, a zone or the feature dictionary changes, so the phone can keep its copy until then.
  const version = crypto.createHash("sha1").update(JSON.stringify([places.rows, areas, zones, featureList()])).digest("hex").slice(0, 16);
  cache = { at: Date.now(), places: places.rows, areas, zones, version };
  return cache;
}

/** A compound suggestion also names the areas it is in besides its own (Golden Square, North 90th…). */
function withZones(item, { zones, areas }, lang) {
  if (!item || item.kind !== "compound") return item;
  const names = zones.filter((z) => z.place_id === item.id).map((z) => areas.find((a) => a.id === z.area_id)).filter(Boolean);
  return { ...item, zones: names.map((a) => (lang === "ar" ? a.name_ar || a.name_en : a.name_en || a.name_ar)) };
}

/** The unit box's list for what is typed: places first, then features (domain/unitBox.js). */
async function box(pool, text, lang = "ar") {
  const l = await lists(pool);
  const q = String(text || "").slice(0, 80);
  const places = A.suggest(q, l, 6, lang).map((it) => withZones(it, l, lang));
  return [...places, ...UnitBox.suggestFeatures(q, lang, 6)];
}

/**
 * The box's place chip for a unit's fields: its compound (known when a name or alias of an approved place), else its sub-zone
 * or area. { label, path, zones, known } or null.
 */
async function placeChip(pool, { compound, area_id, subzone_id } = {}, lang = "ar") {
  const l = await lists(pool);
  const nm = (r) => (lang === "en" ? r.name_en || r.name_ar : r.name_ar || r.name_en);
  const asItem = (row) => A.suggest(nm(row), l, 20, lang).find((s) => s.id === row.id) || null;
  const typed = String(compound || "").trim();
  if (typed) {
    const k = placeKey(typed);
    const row = l.places.find((p) => keysOf(p).includes(k));
    const it = row && asItem(row);
    return it ? { ...withZones(it, l, lang), known: true } : { label: typed, path: "", zones: [], known: false };
  }
  const area = l.areas.find((a) => a.id === (subzone_id || area_id));
  const it = area && asItem(area);
  return it ? { ...it, zones: [], known: true } : null;
}

/** A pasted message → the place and the features it names, for the box's chips. */
async function boxResolve(pool, text, lang = "ar") {
  const l = await lists(pool);
  const r = UnitBox.resolve(text, l, lang);
  return { place: withZones(r.place, l, lang), features: r.features.map((key) => ({ key, label: Features.featureLabel(key, lang) })) };
}

/** Up to `limit` suggestions for the text: [{kind, id, name_en, name_ar, path, via}]. */
async function suggest(pool, text, limit = 8, lang = "en") {
  const { places, areas } = await lists(pool);
  return A.suggest(String(text || "").slice(0, 80), { places, areas }, Math.min(Math.max(1, limit), 20), lang === "ar" ? "ar" : "en");
}

/** The whole approved list for the phone to keep: { version, places, areas, zones, features }. With the version the phone already holds: { version, unchanged: true }. */
async function listing(pool, since = "") {
  const { places, areas, zones, version } = await lists(pool);
  if (since && since === version) return { version, unchanged: true };
  return { version, places, areas, zones, features: featureList() };
}

/** Forget the cached lists (after the owner approves, merges or edits a place or an area). */
function resetCache() {
  cache = { at: 0, places: [], areas: [], zones: [], version: "" };
  require("./areaSearch").resetCache();
}

module.exports = { suggest, listing, box, boxResolve, placeChip, resetCache, lists };
