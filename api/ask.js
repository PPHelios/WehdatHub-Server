// api/ask.js — Ask for the app: the same assistant as the website (services/assistant.js) answering from the agency's
// projects, units and the broker's own leads, counted against the agency's AI allowance.
"use strict";

const Assistant = require("../services/assistant");
const ProjectSearch = require("../services/projectSearch");
const AnswerLine = require("../domain/projectAnswerLine");
const AI = require("../lib/ai");
const AiBlock = require("../lib/aiBlock");
const RateLimit = require("../lib/rateLimit");
const { isAgencyOwner } = require("../lib/authz");

function register(api, { pool }) {
  api.post("/ask", async (req, res) => {
    const { broker } = req.session;
    const lang = broker.preferred_lang === "en" ? "en" : "ar";
    const question = String((req.body && req.body.question) || "").trim();
    if (!question) return res.status(400).json({ error: "empty" });
    if (!(await RateLimit.apiGate(pool, res, `search:broker:${broker.id}`, RateLimit.LIMITS.searchBroker))) return;
    // The AI answers first; the line written from the results by code is the second opinion (kept for the comparison) and, with the AI off or
    // out of credit, the answer itself (source: "local").
    const data = await ProjectSearch.fromQuery(pool, broker, { q: question }, { AI }).catch(() => null);
    const out = await Assistant.ask(pool, broker, question, { channel: "web", results: data });
    const local = data ? AnswerLine.line(data, lang) : "";
    if (out.error === "empty") return res.status(400).json({ error: "empty" });
    if (out.error || !out.question_id) {
      if (data && data.total_projects) {
        await Assistant.noteAnswers(pool, broker, { question, local, source: "local", logId: data.log_id, found: true, channel: "web" });
        return res.json({ answer: local, found: true, lang, dataDates: null, source: "local", log_id: data.log_id });
      }
      if (!out.error) return res.json({ answer: out.answer, found: Boolean(out.found), lang: out.lang, dataDates: Assistant.datesLine(out.dates || [], out.lang) || null, source: "local", log_id: data ? data.log_id : null });
      if (out.error === "ai") return res.status(503).json({ error: "ai_unavailable" });
      return res.status(402).json({ error: "ai_blocked", message: AiBlock.text(out.error, lang, { owner: isAgencyOwner(broker) }) });
    }
    await Assistant.noteAnswers(pool, broker, { questionId: out.question_id, ai: out.answer, local, source: "ai", logId: data && data.log_id, channel: "web" });
    return res.json({ answer: out.answer, found: Boolean(out.found), lang: out.lang, dataDates: Assistant.datesLine(out.dates || [], out.lang) || null, source: "ai", log_id: data ? data.log_id : null });
  });

  // "Wrong results?" and what the broker did next (changed a filter or sort, removed a chip, turned a page, opened or sent a project): the app posts these
  // with the log_id of the results. POST /ask/report { log_id, note } | POST /ask/action { log_id, action: filter|sort|chip_drop|page|open|send, detail }.
  const SearchLog = require("../services/searchLog");
  api.post("/ask/report", async (req, res) => {
    const b = req.body || {};
    const r = await SearchLog.report(pool, req.session.broker, String(b.log_id || ""), b.note);
    if (r.ok) await SearchLog.action(pool, req.session.broker, String(b.log_id), "report");
    return r.ok ? res.json({ ok: true }) : res.status(r.error === "again" ? 409 : 404).json({ error: r.error });
  });
  api.post("/ask/action", async (req, res) => {
    const b = req.body || {};
    const r = await SearchLog.action(pool, req.session.broker, String(b.log_id || ""), String(b.action || ""), b.detail);
    return r.ok ? res.status(204).end() : res.status(404).json({ error: "not_found" });
  });

  // The grouped results for a question (services/projectSearch.js): every project once, with the offers that fit or its free text. The question's
  // filters become chips (drop one with ?drop=place,area,price,down,inst,beds,features); pmin pmax amin amax dmax imax bed are explicit filters over
  // them; sort = best|cheap|pricey|small|big|down; page and per (10, at most 25). The website's Ask page shows the same list.
  api.get("/ask/results", async (req, res) => {
    const q = String(req.query.q || "").trim().slice(0, 500);
    if (!q) return res.status(400).json({ error: "empty" });
    const data = await ProjectSearch.fromQuery(pool, req.session.broker, req.query, { AI });
    return res.json({ ...data, answer_line: AnswerLine.line(data, req.session.broker.preferred_lang === "en" ? "en" : "ar") });
  });
}

module.exports = { register };
