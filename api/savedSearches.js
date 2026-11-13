// api/savedSearches.js — The broker's saved searches for the app. Same service as the website (services/savedSearches.js).
"use strict";

const Saved = require("../services/savedSearches");
const Search = require("../services/search");
const { unitView } = require("./units");

const PAGE = 30;

function register(api, { pool }) {
  api.get("/saved-searches", async (req, res) => {
    const items = await Saved.list(pool, req.session.broker);
    res.json({ items: items.map((x) => ({ id: x.id, name: x.name, total: x.total, fresh: x.fresh })), max: Saved.MAX_SAVED });
  });
  api.post("/saved-searches", async (req, res) => {
    const out = await Saved.save(pool, req.session.broker, { token: req.body?.f, name: req.body?.name });
    if (out.error) return res.status(out.error === "limit" ? 409 : 422).json({ error: out.error });
    return res.json({ ok: true, id: out.id });
  });
  // Opens one: its units now (the first page), and marks them as seen so "new" counts from here.
  api.get("/saved-searches/:id", async (req, res) => {
    const b = req.session.broker;
    const saved = await Saved.get(pool, b, req.params.id);
    if (!saved) return res.status(404).json({ error: "not_found" });
    const out = await Search.runSearch(pool, b.agency_id, { filters: saved.filters }, { pageSize: PAGE });
    await Saved.markSeen(pool, saved.id, out.ids);
    return res.json({ name: saved.name, total: out.total, items: out.rows.map((r) => ({ ...unitView(r), mine: r.broker_id === b.id, photo: null, thumb: null })) });
  });
  api.post("/saved-searches/:id/delete", async (req, res) => {
    return (await Saved.remove(pool, req.session.broker, req.params.id)) ? res.json({ ok: true }) : res.status(404).json({ error: "not_found" });
  });
}

module.exports = { register };
