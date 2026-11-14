// api/ask.js — Ask for the app: the same assistant as the website (services/assistant.js) answering from the agency's
// projects, units and the broker's own leads, counted against the agency's AI allowance.
"use strict";

const Assistant = require("../services/assistant");
const ProjectAnswer = require("../services/projectAnswer");
const Q = require("../domain/searchQuery");
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

  // The grouped results for a question: projects with their fitting offers, the filters read from the question (each can
  // be dropped with ?drop=area,place,price,down,inst), sort best|cheap, 10 projects a page. Same list as the website's.
  const DROPS = { place: ["locations", "places", "place_terms"], area: ["area_min", "area_max"], price: ["price_min", "price_max"], down: ["max_down_payment"], inst: ["max_installment"] };
  api.get("/ask/results", async (req, res) => {
    const { broker } = req.session;
    const q = String(req.query.q || "").trim().slice(0, 500);
    if (!q) return res.status(400).json({ error: "empty" });
    const f = Q.fallbackParse(q).filters;
    const dropped = String(req.query.drop || "").split(",").filter((k) => DROPS[k]);
    for (const k of dropped) for (const key of DROPS[k]) f[key] = Array.isArray(f[key]) ? [] : null;
    const chips = Object.entries(DROPS)
      .filter(([k]) => !dropped.includes(k))
      .map(([k, keys]) => [k, Object.fromEntries(keys.map((key) => [key, f[key]]).filter(([, v]) => (Array.isArray(v) ? v.length : v != null)))])
      .filter(([, v]) => Object.keys(v).length)
      .map(([key, value]) => ({ key, value }));
    const r = await ProjectAnswer.projectResults(pool, broker.agency_id, f, { page: Number(req.query.page) || 1, perPage: 10, sort: req.query.sort === "cheap" ? "cheap" : "best" });
    const lang = broker.preferred_lang === "en" ? "en" : "ar";
    return res.json({
      chips,
      dropped,
      total_projects: r.total_projects,
      total_offers: r.total_offers,
      page: r.page,
      pages: r.pages,
      projects: r.projects.map((g) => ({
        name: g.project.name,
        name_en: g.project.name_en || null,
        place: [g.project.district, g.project.city].filter(Boolean).join(" · "),
        offers: g.offers.map((u) => ({ area: u.area ?? null, floor: u.floor ?? null, price: u.price ?? null, down: u.down ?? null, monthly: u.monthly ?? u.monthly_est ?? null })),
        client_text: ProjectAnswer.clientText(g.offers.slice(0, 5).map((unit) => ({ project: g.project, unit })), lang)
      }))
    });
  });
}

module.exports = { register };
