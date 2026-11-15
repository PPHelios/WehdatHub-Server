// web/routes/placeSuggest.js — The same suggestion list as the app (GET /app/places/suggest), for the website's place boxes,
// and the unit box's list and reader (the app has the same routes: api/places.js).
"use strict";

const Suggest = require("../../services/placeSuggest");

function register(web, { pool }) {
  const langOf = (req) => (req.session?.broker?.preferred_lang === "en" ? "en" : "ar");
  web.get("/places/suggest", async (req, res) => {
    res.set("Cache-Control", "no-store");
    return res.json({ items: await Suggest.suggest(pool, req.query.q, 8, langOf(req)) });
  });
  // The unit box: places, then features, for what is typed.
  web.get("/places/box", async (req, res) => {
    res.set("Cache-Control", "no-store");
    return res.json({ items: await Suggest.box(pool, req.query.q, langOf(req)) });
  });
  // A pasted message → the place and features it names (no AI, no credits).
  web.post("/places/box/resolve", async (req, res) => {
    res.set("Cache-Control", "no-store");
    return res.json(await Suggest.boxResolve(pool, String((req.body || {}).text || ""), langOf(req)));
  });
}

module.exports = { register };
