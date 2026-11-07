// scripts/build-map-seed.js — Builds the first list of map places (data/map-seed/places.json and a CSV to review) from a
// local .pmtiles map file: every named residential place in the "pois" layer (compounds, gated communities), with the
// phases and clusters of one compound merged into one place at their average position.
//   node scripts/build-map-seed.js <file.pmtiles> [west,south,east,north] [zoom]
// Needs the dev tools pmtiles, @mapbox/vector-tile and pbf (npm install). Reads the file from disk; no network.
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { placeKey } = require("../domain/mapPlaces");

const ARABIC = /[؀-ۿ]/;
const LATIN = /[a-z]/i;
const SKIP = /(square|ميدان|hospital|مستشفى|school|مدرسة|mosque|مسجد|garage|جراج|parking|station|محطة|housing|مساكن|gas|بنزينة|bakery|مخبز|pharmacy|صيدلية|cemetery|مقابر|parcel|plot|قطعة|^[a-z]\d+\b|\b[gb]\d{1,3}\b)/i;
// "Hyde Park Cluster 4", "Palm Hills Katameya Phase 2", "امتداد كمبوند …": the compound without its part.
const PART_EN = /\s+(cluster|phase|parcel|stage|zone|block|ext\.?|extension|villas?|v\d)\b.*$/i;
const PART_AR = /\s+(مرحلة|مرحله|كلستر|كلاستر|امتداد|قطعة|فيلات)\s*.*$/;

async function main() {
  const [file, bboxArg = "27.0,29.85,31.9,31.7", zoomArg = "15"] = process.argv.slice(2);
  if (!file) throw new Error("usage: node scripts/build-map-seed.js <file.pmtiles> [west,south,east,north] [zoom]");
  const [west, south, east, north] = bboxArg.split(",").map(Number);
  const Z = Number(zoomArg);
  const { PMTiles } = await import("pmtiles");
  const { VectorTile } = await import("@mapbox/vector-tile");
  const { PbfReader } = await import("pbf");
  const fd = fs.openSync(file, "r");
  const source = {
    getKey: () => file,
    async getBytes(offset, length) {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, offset);
      return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + length) };
    }
  };
  const pm = new PMTiles(source);
  const tx = (lon) => Math.floor(((lon + 180) / 360) * 2 ** Z);
  const ty = (lat) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** Z);
  };
  const groups = new Map();
  const seen = new Set();
  for (let x = tx(west); x <= tx(east); x++) {
    for (let y = ty(north); y <= ty(south); y++) {
      const t = await pm.getZxy(Z, x, y);
      if (!t) continue;
      let data = Buffer.from(t.data);
      if (data[0] === 0x1f && data[1] === 0x8b) data = zlib.gunzipSync(data);
      const layer = new VectorTile(new PbfReader(data)).layers.pois;
      if (!layer) continue;
      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i);
        const p = f.properties;
        if (p.kind !== "residential") continue;
        const raw = String(p.name || "").trim();
        if (!raw || SKIP.test(raw) || SKIP.test(String(p["name:en"] || ""))) continue;
        const g = f.toGeoJSON(x, y, Z).geometry;
        if (g.type !== "Point") continue;
        const [lng, lat] = g.coordinates;
        if (lng < west || lng > east || lat < south || lat > north) continue;
        const dupe = `${raw}|${lat.toFixed(5)}|${lng.toFixed(5)}`;
        if (seen.has(dupe)) continue;
        seen.add(dupe);
        let en = String(p["name:en"] || "").trim() || (LATIN.test(raw) && !ARABIC.test(raw) ? raw : "");
        let ar = String(p["name:ar"] || "").trim() || (ARABIC.test(raw) ? raw : "");
        en = en.replace(PART_EN, "").replace(/^(extension of|extension)\s+/i, "").trim();
        ar = ar.replace(PART_AR, "").replace(/^امتداد\s+/, "").trim();
        const key = placeKey(en || ar);
        if (key.length < 3) continue;
        const cur = groups.get(key) || { name_en: "", name_ar: "", lat: 0, lng: 0, n: 0 };
        cur.name_en ||= en;
        cur.name_ar ||= ar;
        cur.lat += lat;
        cur.lng += lng;
        cur.n += 1;
        groups.set(key, cur);
      }
    }
  }
  const rows = [...groups.values()]
    .map((g) => ({ name_en: g.name_en || null, name_ar: g.name_ar || null, lat: Math.round((g.lat / g.n) * 1e5) / 1e5, lng: Math.round((g.lng / g.n) * 1e5) / 1e5 }))
    .sort((a, b) => (a.name_en || a.name_ar).localeCompare(b.name_en || b.name_ar));
  const dir = path.join(__dirname, "..", "data", "map-seed");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "places.json"), `${JSON.stringify(rows)}\n`);
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  fs.writeFileSync(path.join(dir, "places.csv"), `﻿name_en,name_ar,lat,lng\n${rows.map((r) => [q(r.name_en), q(r.name_ar), r.lat, r.lng].join(",")).join("\n")}\n`);
  console.log(`${rows.length} places from ${seen.size} named residential points`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
