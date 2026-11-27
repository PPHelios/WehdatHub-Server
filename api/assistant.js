// api/assistant.js — Structured executive & operational assistant endpoint (POST /api/v1/assistant/query).
// Keeps Live Web / Telegram / Closed Testing default search (services/search.js) completely untouched.
"use strict";

const AssistantQuery = require("../services/assistantQuery");
const Router = require("../domain/assistantRouter");
const RateLimit = require("../lib/rateLimit");
const AI = require("../lib/ai");
const { scrubQuestion } = require("../domain/assistantFeedback");

const REASONS = ["wrong", "not_asked", "other"];

/** Stores a scrubbed miss. Fire-and-forget: a failure is swallowed and nothing (no question text) is logged. */
function saveMiss(pool, broker, { q, lang, intent, route, verdict, reason }) {
  const l = lang === "en" ? "en" : lang === "ar" ? "ar" : broker.preferred_lang === "en" ? "en" : "ar";
  return pool.query(
    "INSERT INTO assistant_feedback (agency_id, broker_id, role, lang, intent, route, verdict, reason, question) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [broker.agency_id, broker.id, broker.role || null, l, String(intent || "").slice(0, 40) || null, route ? String(route).slice(0, 40) : null, verdict, reason || null, scrubQuestion(q)]
  );
}

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
      previousContext,
      lang: body.lang
    });
    if (out.error) return res.status(400).json({ error: out.error });
    // Generic "didn't get that" only (not market/mode/context choices): kept so the owner can teach the assistant.
    if (out.intent === "clarify" && out.understood?.job === "clarify_question") {
      saveMiss(pool, broker, { q, intent: "clarify", route: "clarify", verdict: "clarify" }).catch(() => {});
    }
    return res.json(out);
  });

  api.post("/assistant/feedback", async (req, res) => {
    const { broker } = req.session;
    const body = req.body || {};
    const q = typeof body.q === "string" ? body.q.trim() : "";
    if (!q || q.length > 1000 || body.verdict !== "down") return res.status(422).json({ error: "invalid_feedback" });
    if (body.reason != null && !REASONS.includes(body.reason)) return res.status(422).json({ error: "invalid_feedback" });
    if (!(await RateLimit.apiGate(pool, res, `search:broker:${broker.id}`, RateLimit.LIMITS.searchBroker))) return;
    await saveMiss(pool, broker, { q, lang: body.lang, intent: body.intent, route: body.route, verdict: "down", reason: body.reason });
    return res.status(204).end();
  });
}

module.exports = { register };
