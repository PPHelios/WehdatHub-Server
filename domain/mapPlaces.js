// domain/mapPlaces.js — Pure rules for the map (no database): the key a compound name is matched by, matching a unit's
// compound to a place, reading coordinates from a Google Maps link, and checking a place before it is saved.
"use strict";

const { nameKey } = require("./placeNames");

// Words that do not tell compounds apart ("Beverly Hills Compound" and "Beverly Hills" are one place).
const NOISE = new Set(["compound", "resort", "كمبوند", "كومباوند"]);
// Egypt, with a margin (the table's CHECK is wider on purpose).
const BOUNDS = { lat: [21.5, 32], lng: [24.5, 37] };

/** Key for matching: the normalized name without the words in NOISE. */
function placeKey(name) {
  return nameKey(name)
    .split(" ")
    .filter((w) => w && !NOISE.has(w))
    .join(" ");
}

/** Every key a place answers to: English name, Arabic name, aliases. */
function keysOf(place) {
  const out = new Set();
  for (const n of [place.name_en, place.name_ar, ...(place.aliases || [])]) {
    const k = placeKey(n);
    if (k.length >= 2) out.add(k);
  }
  return [...out];
}

/** key -> place id. A verified place wins when two places share a key. */
function buildIndex(places) {
  const index = new Map();
  const ordered = [...places].sort((a, b) => Number(Boolean(b.verified)) - Number(Boolean(a.verified)));
  for (const p of ordered) for (const k of keysOf(p)) if (!index.has(k)) index.set(k, p.id);
  return index;
}

/** The place id for a unit's compound names (Arabic and English columns), or null. */
function matchCompound(index, ...names) {
  for (const n of names) {
    const id = index.get(placeKey(n));
    if (id) return id;
  }
  return null;
}

// Unit details written after the compound ("Rehab 1, 3rd floor", "Mivida / villa 12", "Hyde Park - 3 rooms").
const DETAIL = /\s*(?:[\/,،;|(]|\s-\s|\s+(?:\d+(?:st|nd|rd|th)?\s*floor|floor\s*\d+|الدور|دور\s*\d|unit\s*\d|apt\b|apartment|bldg|building|عمارة|شقة|villa\s*\d|فيلا\s*\d|\d+\s*(?:rooms?|beds?|bedrooms?|غرف|غرفة))).*$/i;

/** Splits "Rehab 1, 3rd floor" into the compound part and the details left over. */
function splitCompound(text) {
  const s = String(text ?? "").trim();
  const m = s.match(DETAIL);
  const name = (m ? s.slice(0, m.index) : s).trim();
  return { name, extra: m ? s.slice(m.index).replace(/^[\s\/,،;|(-]+|[\s)]+$/g, "").trim() : "" };
}

/**
 * Finds the approved place for what a person wrote: the whole text, then the compound part, then without a trailing
 * number ("Rehab 2" -> "Rehab"), then the longest leading words. A match from the last two steps is not exact.
 * @returns {{id: string, exact: boolean, extra: string}|null}
 */
function resolveName(index, text) {
  const { name, extra } = splitCompound(text);
  const whole = index.get(placeKey(text));
  if (whole) return { id: whole, exact: true, extra: "" };
  const part = index.get(placeKey(name));
  if (part) return { id: part, exact: true, extra };
  const words = placeKey(name).split(" ").filter(Boolean);
  for (let n = words.length - 1; n >= 1; n--) {
    const id = index.get(words.slice(0, n).join(" "));
    const rest = words.slice(n).join(" ");
    if (id && (n >= 2 || /^\d+$/.test(rest))) return { id, exact: /^\d+$/.test(rest), extra: [rest, extra].filter(Boolean).join(", ") };
  }
  return null;
}

const inEgypt = (lat, lng) => lat >= BOUNDS.lat[0] && lat <= BOUNDS.lat[1] && lng >= BOUNDS.lng[0] && lng <= BOUNDS.lng[1];

/**
 * Coordinates from text a person pasted: a full Google Maps link (…@30.01,31.49…, …!3d30.01!4d31.49…, ?q=30.01,31.49)
 * or plain "30.01, 31.49". Short links (maps.app.goo.gl) cannot be read without opening them.
 * @returns {{lat: number, lng: number}|{error: "empty"|"short_link"|"not_found"|"outside_egypt"}}
 */
function parseMapsLink(text) {
  const s = String(text || "").trim();
  if (!s) return { error: "empty" };
  if (/(maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)/i.test(s)) return { error: "short_link" };
  const num = "(-?\\d{1,3}(?:\\.\\d+)?)";
  const patterns = [
    new RegExp(`!3d${num}!4d${num}`),
    new RegExp(`@${num},\\s*${num}`),
    new RegExp(`[?&](?:q|ll|query|center)=${num}(?:,|%2C)\\s*${num}`, "i"),
    new RegExp(`^${num}\\s*[,;\\s]\\s*${num}$`)
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (!m) continue;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    return inEgypt(lat, lng) ? { lat, lng } : { error: "outside_egypt" };
  }
  return { error: "not_found" };
}

/** Aliases typed as one line ("a, b ؛ c") become a clean list. */
function parseAliases(text) {
  return [...new Set(String(text || "").split(/[,،;؛\n]/).map((s) => s.trim()).filter((s) => s.length >= 2 && s.length <= 80))].slice(0, 20);
}

/**
 * Checks and cleans a place typed in the owner's window.
 * @returns {{ok: true, value: object}|{ok: false, error: "name"|"coords"|"outside_egypt"|"link_short"|"link_unreadable"}}
 */
function cleanPlace(input) {
  const clip = (v, n) => String(v || "").trim().slice(0, n) || null;
  const name_en = clip(input.name_en, 120);
  const name_ar = clip(input.name_ar, 120);
  if (!name_en && !name_ar) return { ok: false, error: "name" };
  let lat = input.lat === "" || input.lat == null ? NaN : Number(input.lat);
  let lng = input.lng === "" || input.lng == null ? NaN : Number(input.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    const link = parseMapsLink(input.maps_link);
    if (link.error === "short_link") return { ok: false, error: "link_short" };
    if (link.error === "outside_egypt") return { ok: false, error: "outside_egypt" };
    if (link.error) return { ok: false, error: input.maps_link ? "link_unreadable" : "coords" };
    ({ lat, lng } = link);
  }
  if (!inEgypt(lat, lng)) return { ok: false, error: "outside_egypt" };
  return {
    ok: true,
    value: {
      name_key: placeKey(name_en || name_ar),
      name_en,
      name_ar,
      developer: clip(input.developer, 120),
      district: clip(input.district, 120),
      lat: Math.round(lat * 1e6) / 1e6,
      lng: Math.round(lng * 1e6) / 1e6,
      aliases: Array.isArray(input.aliases) ? input.aliases : parseAliases(input.aliases),
      verified: input.verified === true || input.verified === "on" || input.verified === "1"
    }
  };
}

module.exports = { placeKey, keysOf, buildIndex, matchCompound, splitCompound, resolveName, parseMapsLink, parseAliases, cleanPlace, inEgypt, BOUNDS };
