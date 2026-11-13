// api/leases.js — Leases being tracked: the list (own / team / all), marking a lease handled, and the WhatsApp contacts. Same services as the website.
"use strict";

const Leases = require("../services/leases");
const Store = require("../lib/listingStore");
const { canView } = require("../lib/authz");

const iso = (d) => d.toISOString().slice(0, 10);

function register(api, { pool }) {
  api.get("/leases", async (req, res) => {
    const items = await Leases.list(pool, req.session.broker, { soon: req.query.soon === "1" });
    res.json({ items: items.map((r) => ({ ...r, end: iso(r.end) })) });
  });
  api.post("/units/:code/lease/done", async (req, res) => {
    const b = req.session.broker;
    const listing = await Store.findByCode(pool, b.agency_id, req.params.code);
    if (!listing || !canView(b, listing)) return res.status(404).json({ error: "not_found" });
    const out = await Leases.done(pool, b, listing, req.body?.kind);
    if (out.error) return res.status(out.error === "forbidden" ? 403 : 422).json({ error: out.error });
    return res.json({ ok: true });
  });
  api.get("/units/:code/lease/contacts", async (req, res) => {
    const b = req.session.broker;
    const listing = await Store.findByCode(pool, b.agency_id, req.params.code);
    if (!listing || !canView(b, listing)) return res.status(404).json({ error: "not_found" });
    const lease = await Leases.forListing(pool, listing);
    if (!lease) return res.json({ tenant: null, owner: null });
    return res.json(await Leases.contacts(pool, b, listing, lease));
  });
}

module.exports = { register };
