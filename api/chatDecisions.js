// api/chatDecisions.js — What the agency decided about each post of a WhatsApp chat (saved, discarded, unchanged), shared by every
// broker, device and the website, so importing the same chat again does not ask the same questions. chat_fp / post_fp are
// domain/chatFingerprint.js. Registered before api/units.js: GET /units/:code would otherwise take /units/chat-decisions.
"use strict";

const Rights = require("../services/unitRights");
const RateLimit = require("../lib/rateLimit");
const Decisions = require("../services/chatDecisions");
const ChatFp = require("../domain/chatFingerprint");

function register(api, { pool }) {
  const decisionsGate = async (req, res) => {
    const { broker } = req.session;
    if (!(await Rights.mayWrite(pool, broker))) return void res.status(403).json({ error: "writes_off" });
    const gate = await RateLimit.hit(pool, `crm_write:broker:${broker.id}`, RateLimit.LIMITS.crmWriteBroker);
    if (!gate.allowed) return void res.status(429).set("Retry-After", String(gate.retryAfterSec)).json({ error: "rate_limited" });
    return true;
  };
  api.get("/units/chat-decisions", async (req, res) => {
    if (!(await decisionsGate(req, res))) return;
    if (!ChatFp.isChatFp(req.query.chat_fp)) return res.status(400).json({ error: "bad_chat_fp" });
    res.set("Cache-Control", "no-store");
    return res.json(await Decisions.list(pool, req.session.broker.agency_id, String(req.query.chat_fp)));
  });
  api.put("/units/chat-decisions", async (req, res) => {
    if (!(await decisionsGate(req, res))) return;
    if (!ChatFp.isChatFp(req.body?.chat_fp)) return res.status(400).json({ error: "bad_chat_fp" });
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length > Decisions.MAX_PER_REQUEST) return res.status(413).json({ error: "too_many", max: Decisions.MAX_PER_REQUEST });
    const { broker } = req.session;
    const stored = await Decisions.record(pool, broker.agency_id, broker.id, String(req.body.chat_fp), items);
    return res.json({ ok: true, stored });
  });
  api.delete("/units/chat-decisions", async (req, res) => {
    if (!(await decisionsGate(req, res))) return;
    if (!ChatFp.isChatFp(req.body?.chat_fp)) return res.status(400).json({ error: "bad_chat_fp" });
    const removed = await Decisions.forget(pool, req.session.broker.agency_id, String(req.body.chat_fp), Array.isArray(req.body?.post_fps) ? req.body.post_fps : null);
    return res.json({ ok: true, removed });
  });

}

module.exports = { register };
