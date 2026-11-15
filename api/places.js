// api/places.js — One suggestion list for place boxes in the app: compounds, aliases, areas and sub-zones together.
"use strict";

const Suggest = require("../services/placeSuggest");

function register(api, { pool }) {
  // GET /places/suggest?q=… → { items: [{ kind: "compound"|"area"|"subzone", id, name_en, name_ar, path, via }] }
  api.get("/places/suggest", async (req, res) => {
    const items = await Suggest.suggest(pool, req.query.q, Number(req.query.limit) || 8, req.query.lang === "ar" ? "ar" : "en");
    return res.json({ items });
  });

  // GET /places/list[?since=<version>] → { version, places, areas, zones, features } or { version, unchanged: true }.
  // The app keeps this list and matches typing on the phone (same rules as /places/suggest, see domain/areas.js).
  api.get("/places/list", async (req, res) => {
    return res.json(await Suggest.listing(pool, String(req.query.since || "").slice(0, 40)));
  });

  // The unit box (docs/plans/unified-unit-box.md), the same as the website's:
  // GET /places/box?q=… → { items: [place suggestions…, { kind: "feature", key, label }…] }
  api.get("/places/box", async (req, res) => {
    return res.json({ items: await Suggest.box(pool, req.query.q, req.query.lang === "en" ? "en" : "ar") });
  });
  // POST /places/box/resolve { text } → { place, features: [{ key, label }] }: what a pasted message names, no AI.
  api.post("/places/box/resolve", async (req, res) => {
    return res.json(await Suggest.boxResolve(pool, String((req.body || {}).text || ""), req.query.lang === "en" ? "en" : "ar"));
  });
}

module.exports = { register };
