// api/search.js — Text search for the app: the same reading and the same query as the website's search
// (services/search.js, behind lib/visibility, the agency's AI switch and the broker's search rate limit).
"use strict";

const Search = require("../services/search");
const AI = require("../lib/ai");
const RateLimit = require("../lib/rateLimit");
const Q = require("../domain/searchQuery");
const Storage = require("../lib/supabase");
const AiBlock = require("../lib/aiBlock");
const { isAgencyOwner } = require("../lib/authz");
const { uploads, VOICE } = require("../web/uploads");
const { unitView } = require("./units");

const PAGE = 20;
const MAX_SPOKEN_SEARCH = 200;

function register(api, { pool }) {
  api.get("/search", async (req, res) => {
    const { broker } = req.session;
    const text = String(req.query.q || "").trim().slice(0, 500);
    if (!text) return res.status(400).json({ error: "empty" });
    const gate = await RateLimit.hit(pool, `search:broker:${broker.id}`, RateLimit.LIMITS.searchBroker);
    if (!gate.allowed) return res.status(429).set("Retry-After", String(gate.retryAfterSec)).json({ error: "rate_limited" });
    const forceAi = req.query.ai === "1";
    // "Search without them": the broker saw which words were not understood and chose to search anyway.
    const drop = req.query.drop === "1";
    const parse = await Search.parseRequest(AI, { text, ctx: { pool, AI, broker, agency: req.session.agency, lang: broker.preferred_lang === "en" ? "en" : "ar" }, forceAi });
    const intent = Q.classifyIntent(parse.parsed);
    const base = { source: parse.source, aiError: parse.aiError || null };
    if (intent !== "search") return res.json({ ...base, status: intent, total: 0, items: [] });
    const out = await Search.runSearch(pool, broker.agency_id, parse.parsed, { pageSize: PAGE, ask: !drop });
    // The AI could not answer and a number was left unplaced: ask, never search as if it were not there.
    const numbers = parse.source === "fallback" && !drop ? parse.local?.meta?.leftover_numbers || [] : [];
    if (numbers.length) out.ask = { terms: out.ask?.terms || [], numbers, aiDown: true, withoutTotal: out.ask ? out.ask.withoutTotal : out.total };
    if (out.ask) return res.json({ ...base, status: "ask", total: 0, items: [], ask: out.ask });
    const photos = out.rows.length
      ? (await pool.query("SELECT DISTINCT ON (listing_id) listing_id, url FROM listing_images WHERE listing_id = ANY($1::uuid[]) AND agency_id = $2 ORDER BY listing_id, position", [out.rows.map((r) => r.id), broker.agency_id])).rows
      : [];
    const photoOf = new Map(photos.map((p) => [p.listing_id, Storage.photoUrl(p.url)]));
    return res.json({
      ...base,
      status: out.rows.length ? "results" : "none",
      total: Math.min(out.total, Search.SNAPSHOT_MAX),
      relaxed: out.relaxed,
      ignoredTerms: out.ignoredTerms || [],
      items: out.rows.map((r) => ({ ...unitView(r), mine: r.broker_id === broker.id, photo: photoOf.get(r.id) || null }))
    });
  });

  // Voice search: the app sends a note; the AI writes it down (counted against the agency's voice allowance) and the app then
  // searches that text as if it were typed. `fallback: true` tells the app to offer typing instead.
  api.post("/search/voice", uploads([VOICE]), async (req, res) => {
    const { broker } = req.session;
    const lang = broker.preferred_lang === "en" ? "en" : "ar";
    const voice = req.files && req.files.voice && req.files.voice[0];
    if (!voice) return res.status(400).json({ error: "no_audio" });
    const gate = await RateLimit.hit(pool, `search:broker:${broker.id}`, RateLimit.LIMITS.searchBroker);
    if (!gate.allowed) return res.status(429).set("Retry-After", String(gate.retryAfterSec)).json({ error: "rate_limited" });
    try {
      const heard = String(await AI.transcribeAudio(voice.buffer, voice.mimetype.split(";")[0], { pool, AI, broker, agency: req.session.agency, lang }) || "").trim();
      // A search is a few words. A long transcript from silence is the model making up speech, so it is not used.
      const q = heard.length > MAX_SPOKEN_SEARCH ? "" : heard.slice(0, 500);
      if (!q) return res.status(422).json({ error: "not_heard" });
      return res.json({ q });
    } catch (err) {
      const why = AiBlock.kindOf(err);
      if (why !== "ai") return res.status(402).json({ error: "ai_blocked", message: AiBlock.text(why, lang, { owner: isAgencyOwner(broker) }), fallback: true });
      return res.status(503).json({ error: "ai_unavailable", fallback: true });
    }
  });
}

module.exports = { register };
