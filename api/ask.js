// api/ask.js — Ask for the app: the same assistant as the website (services/assistant.js) answering from the agency's
// projects, units and the broker's own leads, counted against the agency's AI allowance.
"use strict";

const Assistant = require("../services/assistant");
const AiBlock = require("../lib/aiBlock");
const RateLimit = require("../lib/rateLimit");
const { isAgencyOwner } = require("../lib/authz");

function register(api, { pool }) {
  api.post("/ask", async (req, res) => {
    const { broker } = req.session;
    const lang = broker.preferred_lang === "en" ? "en" : "ar";
    const question = String((req.body && req.body.question) || "").trim();
    if (!question) return res.status(400).json({ error: "empty" });
    const gate = await RateLimit.hit(pool, `search:broker:${broker.id}`, RateLimit.LIMITS.searchBroker);
    if (!gate.allowed) return res.status(429).set("Retry-After", String(gate.retryAfterSec)).json({ error: "rate_limited" });
    const out = await Assistant.ask(pool, broker, question, { channel: "web" });
    if (out.error === "empty") return res.status(400).json({ error: "empty" });
    if (out.error === "ai") return res.status(503).json({ error: "ai_unavailable" });
    if (out.error) return res.status(402).json({ error: "ai_blocked", message: AiBlock.text(out.error, lang, { owner: isAgencyOwner(broker) }) });
    return res.json({ answer: out.answer, found: Boolean(out.found), lang: out.lang, dataDates: Assistant.datesLine(out.dates || [], out.lang) || null });
  });
}

module.exports = { register };
