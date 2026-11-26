// api/assistant.js — Structured executive & operational assistant endpoint (POST /api/v1/assistant/query).
// Keeps Live Web / Telegram / Closed Testing default search (services/search.js) completely untouched.
"use strict";

const AssistantQuery = require("../services/assistantQuery");
const Router = require("../domain/assistantRouter");
const RateLimit = require("../lib/rateLimit");
const AI = require("../lib/ai");

function register(api, { pool }) {
  api.post("/assistant/query", async (req, res) => {
    const { broker } = req.session;
    const body = req.body || {};
    const q = String(body.q || "").trim();
    if (!q) return res.status(400).json({ error: "empty" });
    const mode = body.mode === undefined ? "auto" : String(body.mode);
    if (!Router.MODES.includes(mode)) return res.status(422).json({ error: "invalid_scope" });
    const previousContext = body.previousContext && typeof body.previousContext === "object" ? body.previousContext : null;
    if (!(await RateLimit.apiGate(pool, res, `search:broker:${broker.id}`, RateLimit.LIMITS.searchBroker))) return;
    const out = await AssistantQuery.query(pool, {
      AI,
      actor: broker,
      agency: req.session.agency || null,
      text: q,
      mode,
      previousContext
    });
    if (out.error) return res.status(400).json({ error: out.error });
    return res.json(out);
  });
}

module.exports = { register };
