// api/access.js — Private-details requests and the activity log for managers (same services as the website pages).
"use strict";

const Queue = require("../services/accessQueue");
const ActivityLog = require("../services/activityLog");
const Authz = require("../lib/authz");

const DAY = 24 * 3600 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isoOrNull = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v || "")) && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);

function register(api, { pool }) {
  const guard = (req, res, next) => (Authz.isManager(req.session.broker) ? next() : res.status(403).json({ error: "forbidden" }));

  api.get("/access-requests", guard, async (req, res) => {
    const status = [...Queue.STATUSES, "all"].includes(req.query.status) ? req.query.status : "pending";
    const page = Math.max(0, parseInt(req.query.page, 10) || 0);
    const out = await Queue.list(pool, req.session.broker, { from: new Date(Date.now() - 90 * DAY), to: new Date(Date.now() + DAY), status, q: String(req.query.q || "").trim().slice(0, 60), offset: page * 20, limit: 20 });
    res.json({ items: out.rows, total: out.total });
  });

  api.post("/access-requests/:id", guard, async (req, res) => {
    if (!/^\d{1,12}$/.test(req.params.id) || !["approve", "decline"].includes(req.body?.decision)) return res.status(422).json({ error: "bad_request" });
    const r = await Queue.answer(pool, req.session.broker, Number(req.params.id), req.body.decision === "approve");
    return r.ok === false ? res.status(r.reason === "not_found" ? 404 : 403).json({ error: r.reason || "forbidden" }) : res.json({ ok: true });
  });

  api.get("/activity-log", guard, async (req, res) => {
    const person = UUID.test(String(req.query.person || "")) ? String(req.query.person) : null;
    const log = await ActivityLog.list(pool, req.session.broker, { offset: Math.max(0, parseInt(req.query.page, 10) || 0) * ActivityLog.PAGE, from: isoOrNull(req.query.from), to: isoOrNull(req.query.to), person, action: String(req.query.action || "").trim().slice(0, 40) || null });
    if (!log) return res.status(403).json({ error: "forbidden" });
    const lang = req.session.broker.preferred_lang === "en" ? "en" : "ar";
    res.json({ items: log.rows.map((r) => ({ id: r.id, at: r.created_at, who: r.broker_name || "", text: ActivityLog.describe(r, lang), device: r.user_agent || "" })), more: log.more });
  });
}

module.exports = { register };
