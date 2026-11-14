// api/requests.js — Client requests for the app (/client-requests; /requests is the managers' "needs help" list): Pending and Fulfilled tabs, add (optionally linked to a lead by code
// or phone), mark fulfilled, delete. Same service as the website (services/clientRequests.js).
"use strict";

const Requests = require("../services/clientRequests");
const Card = require("../domain/leadCard");

const STATUS = { invalid: 422, lead_not_found: 404, forbidden: 403, too_many_requests: 409, too_many_requests_broker: 409, not_found: 404 };

function view(it) {
  return {
    id: it.id,
    summary: Card.requestSummary(it.filters, "ar"),
    summary_en: Card.requestSummary(it.filters, "en"),
    token: it.token,
    lead: it.lead ? { ref: it.lead.ref, name: it.lead.name } : null,
    broker_name: it.broker_name,
    alerts: it.alerts,
    matches: it.matches,
    created_at: it.created_at,
    fulfilled_at: it.fulfilled_at
  };
}

function register(api, { pool }) {
  api.get("/client-requests", async (req, res) => {
    const tab = req.query.tab === "fulfilled" ? "fulfilled" : "pending";
    const out = await Requests.list(pool, req.session.broker, { tab, page: req.query.page });
    res.json({ tab, items: out.items.map(view), page: out.page, pages: out.pages, total: out.total, pending: out.pending, fulfilled: out.fulfilled });
  });
  // { q: "description" } or { filters }, plus an optional lead (code or phone). → { ok, id, lead }
  api.post("/client-requests", async (req, res) => {
    const out = await Requests.add(pool, req.session.broker, { q: req.body?.q, filters: req.body?.filters, lead: req.body?.lead });
    if (out.error) return res.status(STATUS[out.error] || 422).json({ error: out.error });
    return res.json(out);
  });
  api.post("/client-requests/:id/fulfil", async (req, res) => {
    const out = await Requests.fulfil(pool, req.session.broker, req.params.id);
    return out.error ? res.status(404).json({ error: "not_found" }) : res.json({ ok: true });
  });
  api.post("/client-requests/:id/delete", async (req, res) => {
    const out = await Requests.remove(pool, req.session.broker, req.params.id);
    return out.error ? res.status(404).json({ error: "not_found" }) : res.json({ ok: true });
  });
}

module.exports = { register };
