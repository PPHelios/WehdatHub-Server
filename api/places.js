// api/places.js — One suggestion list for place boxes in the app: compounds, aliases, areas and sub-zones together.
"use strict";

const Suggest = require("../services/placeSuggest");

function register(api, { pool }) {
  // GET /places/suggest?q=… → { items: [{ kind: "compound"|"area"|"subzone", id, name_en, name_ar, path, via }] }
  api.get("/places/suggest", async (req, res) => {
    const items = await Suggest.suggest(pool, req.query.q, Number(req.query.limit) || 8);
    return res.json({ items });
  });
}

module.exports = { register };
