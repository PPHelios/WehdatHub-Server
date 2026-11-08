// services/placeLookup.js — Finds a position for places that have a name but no pin: OpenStreetMap first (the same data as
// our map tiles); when it finds nothing, Google (key in GOOGLE_MAPS_API_KEY) as the fallback. When both answer, the distance
// between them tells the owner whether to trust the pin. Nothing is saved here: the owner approves each one.
"use strict";

const P = require("../domain/mapPlaces");

const UA = "WehdatHub/1.0 (map place lookup)";

function km(a, b) {
  const r = (d) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

async function osm(name, fetchFn) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=eg&q=${encodeURIComponent(name)}`;
  const res = await fetchFn(url, { headers: { "User-Agent": UA, "Accept-Language": "en" } });
  if (!res.ok) return null;
  const [hit] = await res.json();
  const pos = hit && { lat: Number(hit.lat), lng: Number(hit.lon) };
  return pos && P.inEgypt(pos.lat, pos.lng) ? pos : null;
}

/** Returns { pos, status }: status is "no_key", "OK", "ZERO_RESULTS", "REQUEST_DENIED", "HTTP_<code>" or "outside_egypt". */
async function google(name, key, fetchFn) {
  if (!key) return { pos: null, status: "no_key" };
  const url = `https://maps.googleapis.com/maps/api/geocode/json?region=eg&address=${encodeURIComponent(`${name}, Egypt`)}&key=${encodeURIComponent(key)}`;
  const res = await fetchFn(url);
  if (!res.ok) return { pos: null, status: `HTTP_${res.status}` };
  const body = await res.json();
  if (body.status !== "OK") return { pos: null, status: body.status || "unknown" };
  const loc = body.results?.[0]?.geometry?.location;
  const pos = loc && { lat: Number(loc.lat), lng: Number(loc.lng) };
  if (pos && P.inEgypt(pos.lat, pos.lng)) return { pos, status: "OK" };
  return { pos: null, status: "outside_egypt" };
}

/** Approved places with no pin, 20 at a time. */
async function missing(pool, { offset = 0, limit = 20 } = {}) {
  const { rows } = await pool.query(
    "SELECT id, name_en, name_ar FROM map_places WHERE approved AND (lat IS NULL OR lng IS NULL) ORDER BY lower(coalesce(name_en, name_ar)) LIMIT $1 OFFSET $2",
    [limit, offset]
  );
  const { rows: [{ n }] } = await pool.query("SELECT count(*)::int AS n FROM map_places WHERE approved AND (lat IS NULL OR lng IS NULL)");
  return { rows, total: n };
}

/**
 * A suggestion for each place. source: "osm" | "google" | null. When both answer, `apart_km` is their distance;
 * the pin offered is OSM's, or Google's only when OSM found nothing.
 */
async function suggest(places, { fetchFn = fetch, key = process.env.GOOGLE_MAPS_API_KEY, pauseMs = 1100 } = {}) {
  const out = [];
  for (const p of places) {
    const name = p.name_en || p.name_ar;
    let o = null;
    let g = null;
    try { o = await osm(`${name} compound`, fetchFn); } catch { o = null; }
    if (!o) { try { o = await osm(name, fetchFn); } catch { o = null; } }
    let gs = "error";
    try { ({ pos: g, status: gs } = await google(name, key, fetchFn)); } catch { g = null; }
    const pos = o || g;
    out.push({ id: p.id, name, pos, source: o ? "osm" : g ? "google" : null, google: g, google_status: gs, apart_km: o && g ? Math.round(km(o, g) * 10) / 10 : null });
    if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs)); // Nominatim allows one request a second
  }
  return out;
}

/** Saves a position the owner approved. */
async function setPosition(pool, id, lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!/^[0-9a-f-]{36}$/i.test(String(id)) || !P.inEgypt(la, ln)) return false;
  const { rowCount } = await pool.query(
    "UPDATE map_places SET lat = $2, lng = $3, updated_at = now() WHERE id = $1 AND approved AND lat IS NULL",
    [id, Math.round(la * 1e6) / 1e6, Math.round(ln * 1e6) / 1e6]
  );
  return rowCount > 0;
}

module.exports = { missing, suggest, setPosition, km };
