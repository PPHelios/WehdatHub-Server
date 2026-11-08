// services/placeLookup.js — Finds a position for places that have a name but no pin: OpenStreetMap first (the same data as
// our map tiles); when it finds nothing, Google (key in GOOGLE_MAPS_API_KEY) as the fallback. When both answer, the distance
// between them tells the owner whether to trust the pin. Nothing is saved here: the owner approves each one.
"use strict";

const P = require("../domain/mapPlaces");
const Vis = require("../lib/visibility");

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
// Rules from the older pipeline that gave mostly right data: Google results must be in Egypt, a precise place (not only a city or
// area), not the Downtown default point, and inside the rough radius of the district when we know that district.
const DOWNTOWN = { lat: 30.04442, lng: 31.235712 };
const PRECISE_TYPES = ["establishment", "premise", "subpremise", "point_of_interest", "route", "street_address"];
// Rough centres and maximum distances (km) for district words; a district with no word here is not checked.
const DISTRICT_RULES = [
  { words: ["new zayed"], lat: 30.1, lng: 30.88, maxKm: 20 },
  { words: ["sheikh zayed", "zayed"], lat: 30.04, lng: 30.98, maxKm: 18 },
  { words: ["6th of october", "october"], lat: 29.97, lng: 30.95, maxKm: 25 },
  { words: ["mostakbal"], lat: 30.06, lng: 31.64, maxKm: 16 },
  { words: ["new capital", "r7"], lat: 30.015, lng: 31.68, maxKm: 22 },
  { words: ["shorouk", "burouj"], lat: 30.15, lng: 31.62, maxKm: 18 },
  { words: ["uptown", "mokattam", "maadi"], lat: 30.015, lng: 31.325, maxKm: 12 },
  { words: ["north coast", "sahel", "alamein", "ras el hekma"], lat: 30.95, lng: 28.75, maxKm: 90 },
  { words: ["sokhna", "galala"], lat: 29.68, lng: 32.32, maxKm: 45 },
];

function districtOk(pos, district) {
  const d = String(district || "").toLowerCase();
  const rule = DISTRICT_RULES.find((r) => r.words.some((w) => d.includes(w)));
  if (!rule || !pos) return true;
  return km(pos, rule) <= rule.maxKm;
}

function genericOnly(result) {
  const types = result.types || [];
  return types.length > 0 && !types.some((t) => PRECISE_TYPES.includes(t));
}

async function google(name, key, fetchFn, district) {
  if (!key) return { pos: null, status: "no_key" };
  const url = `https://maps.googleapis.com/maps/api/geocode/json?components=country:EG&address=${encodeURIComponent(`${name}, Egypt`)}&key=${encodeURIComponent(key)}`;
  const res = await fetchFn(url);
  if (!res.ok) return { pos: null, status: `HTTP_${res.status}` };
  const body = await res.json();
  if (body.status !== "OK") return { pos: null, status: body.status || "unknown" };
  const results = body.results || [];
  const address = results[0]?.formatted_address || null;
  let outside = false;
  let generic = false;
  let far = false;
  for (const r of results) {
    const loc = r.geometry?.location;
    const pos = loc && { lat: Number(loc.lat), lng: Number(loc.lng) };
    if (!pos || !P.inEgypt(pos.lat, pos.lng)) { outside = true; continue; }
    if (genericOnly(r)) { generic = true; continue; }
    if (km(pos, DOWNTOWN) < 2.5 && /qasr el nil/i.test(r.formatted_address || "")) continue;
    if (!districtOk(pos, district)) { far = true; continue; }
    return { pos, status: "OK", address: r.formatted_address || address };
  }
  if (far) return { pos: null, status: "OUT_OF_DISTRICT", address };
  if (generic) return { pos: null, status: "GENERIC_ONLY", address };
  return { pos: null, status: outside ? "outside_egypt" : "ZERO_RESULTS", address };
}

/** Approved places with no pin, 20 at a time. */
async function missing(pool, { offset = 0, limit = 20 } = {}) {
  const { rows } = await pool.query(
    `SELECT m.id, m.name_en, m.name_ar, m.district, m.lat, m.lng, ${UNITS_SQL} AS units FROM map_places m
     WHERE m.approved AND (m.lat IS NULL OR m.lng IS NULL) ORDER BY ${ORDER_SQL} LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const { rows: [{ n }] } = await pool.query("SELECT count(*)::int AS n FROM map_places WHERE approved AND (lat IS NULL OR lng IS NULL)");
  return { rows, total: n };
}

// Owner lists: Cairo areas first, then the places with the most units, then by name.
// The owner counts every unit (not a broker's view): the all-units rule, written out.
const UNITS_SQL = `(SELECT count(*)::int FROM listings l WHERE ${Vis.allUnits()} AND l.place_id = m.id AND l.status <> 'deleted')`;
const ORDER_SQL = "(CASE WHEN m.district ILIKE '%cairo%' THEN 0 ELSE 1 END), units DESC, lower(coalesce(m.name_en, m.name_ar))";

/** Approved places that already have a pin the owner has not double-checked yet, 20 at a time. */
async function unchecked(pool, { limit = 20, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT m.id, m.name_en, m.name_ar, m.district, m.lat, m.lng, ${UNITS_SQL} AS units FROM map_places m
     WHERE m.approved AND m.lat IS NOT NULL AND m.lng IS NOT NULL AND m.pin_checked_at IS NULL ORDER BY ${ORDER_SQL} LIMIT $1 OFFSET $2`,
    [limit, Math.max(0, offset)]
  );
  const { rows: [{ n }] } = await pool.query("SELECT count(*)::int AS n FROM map_places WHERE approved AND lat IS NOT NULL AND lng IS NOT NULL AND pin_checked_at IS NULL");
  return { rows, total: n };
}

/** Marks the places as checked, moving the pin of those the owner chose to move. choices: [{id, lat?, lng?}] */
async function finishCheck(pool, choices) {
  let moved = 0;
  for (const c of choices) {
    if (!/^[0-9a-f-]{36}$/i.test(String(c.id))) continue;
    const la = Number(c.lat);
    const ln = Number(c.lng);
    if (c.lat != null && P.inEgypt(la, ln)) {
      await pool.query("UPDATE map_places SET lat = $2, lng = $3, pin_checked_at = now(), updated_at = now() WHERE id = $1 AND approved", [c.id, Math.round(la * 1e6) / 1e6, Math.round(ln * 1e6) / 1e6]);
      moved += 1;
    } else {
      await pool.query("UPDATE map_places SET pin_checked_at = now() WHERE id = $1 AND approved", [c.id]);
    }
  }
  return { moved };
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
    let ga = null;
    try { ({ pos: g, status: gs, address: ga } = await google(p.district ? `${name}, ${p.district}` : name, key, fetchFn, p.district)); } catch { g = null; }
    if (o && !districtOk(o, p.district)) o = null;
    const pos = o || g;
    out.push({ id: p.id, name, units: p.units ?? null, district: p.district ?? null, saved: p.lat != null ? { lat: p.lat, lng: p.lng } : null, osm: o, pos, source: o ? "osm" : g ? "google" : null, google: g, google_status: gs, google_address: ga, apart_km: o && g ? Math.round(km(o, g) * 10) / 10 : null });
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

/**
 * What the comparison says about a saved pin. "ok": a service finds it within 0.5 km. "move": both services agree with each other
 * (within 0.5 km) and are both over 1 km from the saved pin. Anything else is "review": a person decides.
 */
function verdict(r) {
  if (!r.saved) return "review";
  const dO = r.osm ? km(r.saved, r.osm) : null;
  const dG = r.google ? km(r.saved, r.google) : null;
  if ((dO !== null && dO < 0.5) || (dG !== null && dG < 0.5)) return "ok";
  if (r.osm && r.google && km(r.osm, r.google) < 0.5 && dO > 1 && dG > 1) return "move";
  return "review";
}

module.exports = { missing, unchecked, finishCheck, suggest, setPosition, km, verdict, districtOk };
