// web/assets.js — Static files of the web app, held in memory with content hashes (no disk writes at runtime)
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { cssTokens } = require("../domain/brand");

const STATIC_DIR = path.join(__dirname, "static");
const TYPES = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".csv": "text/csv; charset=utf-8",
  ".woff2": "font/woff2"
};

// Files served under /app/static/ (sw.js is served at /app/sw.js, filled in per version).
const FILES = {
  "app.css": path.join(STATIC_DIR, "app.css"),
  "app.js": path.join(STATIC_DIR, "app.js"),
  "voice.js": path.join(STATIC_DIR, "voice.js"),
  // Match photos (managers): the chat parser and matcher are the server's own pure files, run in the browser too.
  "zipread.js": path.join(STATIC_DIR, "zipread.js"),
  "chatparse.js": path.join(__dirname, "..", "domain", "chatParse.js"),
  "chatmatch.js": path.join(__dirname, "..", "domain", "chatMatch.js"),
  "chatphotos.js": path.join(STATIC_DIR, "chatphotos.js"),
  // The add/edit unit form's photo tray (zip of one unit's photos, ticks, order).
  "unitPhotos.js": path.join(STATIC_DIR, "unitPhotos.js"),
  // Excel import: the workbook is read in the browser, tab by tab.
  "xlsxread.js": path.join(STATIC_DIR, "xlsxread.js"),
  "ximport.js": path.join(STATIC_DIR, "ximport.js"),
  "htmx.min.js": require.resolve("htmx.org/dist/htmx.min.js"),
  // The map page: Leaflet and the vector-tile layer (read from the owner's .pmtiles file), loaded on that page only.
  "leaflet.js": require.resolve("leaflet/dist/leaflet.js"),
  "leaflet.css": require.resolve("leaflet/dist/leaflet.css"),
  "protomaps-leaflet.js": path.join(path.dirname(require.resolve("protomaps-leaflet/package.json")), "dist", "protomaps-leaflet.js"),
  "map.js": path.join(STATIC_DIR, "map.js"),
  // The owner's pin review map (Check saved pins, Missing pins).
  "pinreview.js": path.join(STATIC_DIR, "pinreview.js"),
  // Cairo, self-hosted (CSP font-src 'self'): regular and bold; 600 renders with the bold face.
  "fonts/cairo-400.woff2": path.join(STATIC_DIR, "fonts", "cairo-400.woff2"),
  "fonts/cairo-700.woff2": path.join(STATIC_DIR, "fonts", "cairo-700.woff2"),
  "icons/icon.svg": path.join(STATIC_DIR, "icons", "icon.svg"),
  "icons/icon-192.png": path.join(STATIC_DIR, "icons", "icon-192.png"),
  "icons/icon-512.png": path.join(STATIC_DIR, "icons", "icon-512.png"),
  "icons/maskable-512.png": path.join(STATIC_DIR, "icons", "maskable-512.png"),
  // F12: a sample developer price sheet to download from the project page.
  "samples/price-sheet-sample.csv": path.join(STATIC_DIR, "samples", "price-sheet-sample.csv")
};

// Fetched when the Map page opens, not with every install of the app.
const LAZY = new Set(["leaflet.js", "leaflet.css", "protomaps-leaflet.js", "map.js", "pinreview.js"]);

const hash = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 10);

/** Loads every static file once: { files: name → { body, type, hash }, version, url(name), swSource }. */
function loadAssets() {
  const files = {};
  for (const [name, file] of Object.entries(FILES)) {
    if (!fs.existsSync(file)) continue;
    const body = fs.readFileSync(file);
    files[name] = { body, type: TYPES[path.extname(name)] || "application/octet-stream", hash: hash(body) };
  }
  // The brand's colour tokens (domain/brand.js) and the Cairo faces at their versioned URLs, loaded before app.css.
  const face = (w) => files[`fonts/cairo-${w}.woff2`]
    ? `@font-face { font-family: "Cairo"; font-style: normal; font-weight: ${w === 400 ? "300 500" : "600 900"}; font-display: swap; src: url("/app/static/fonts/cairo-${w}.woff2?v=${files[`fonts/cairo-${w}.woff2`].hash}") format("woff2"); }\n`
    : "";
  const brand = Buffer.from(cssTokens() + face(400) + face(700));
  files["brand.css"] = { body: brand, type: TYPES[".css"], hash: hash(brand) };
  const version = hash(Buffer.from(Object.values(files).map((f) => f.hash).join(".")));
  const url = (name) => {
    const f = files[name];
    if (!f) throw new Error(`Unknown static asset ${name}`);
    return `/app/static/${name}?v=${f.hash}`;
  };
  const swSource = fs
    .readFileSync(path.join(STATIC_DIR, "sw.js"), "utf8")
    .replace('"__VERSION__"', JSON.stringify(version))
    .replace("= __ASSETS__;", `= ${JSON.stringify(Object.keys(files).filter((n) => !LAZY.has(n)).map(url))};`);
  return { files, version, url, swSource };
}

module.exports = { STATIC_DIR, FILES, loadAssets };
