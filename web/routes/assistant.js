// web/routes/assistant.js — "Ask" (Release B, C10 + N1): the assistant on the website. The broker asks about a project,
// their clients, follow-ups or units; the answer comes from the agency's own data only, with the data dates, or says it
// is not in our data. A web answer (owner switch) is shown apart, labelled unverified, with its source links. A found
// answer about a project has a "Send on WhatsApp" button. Managers also see the recent questions the data could not
// answer, so they know what to add. Logic lives in services/assistant.js.
"use strict";

const Assistant = require("../../services/assistant");
const ProjectSearch = require("../../services/projectSearch");
const AnswerLine = require("../../domain/projectAnswerLine");
const Credits = require("../../services/credits");
const AI = require("../../lib/ai");
const { resultsView } = require("../views/projectResults");
const A = require("../../domain/assistant");
const { isManager, isAgencyOwner } = require("../../lib/authz");
const AiBlock = require("../../lib/aiBlock");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const day = (d) => new Date(d).toISOString().slice(0, 10);

const ERRORS = {
  empty: ["اكتب سؤالك.", "Write your question."],
  info: ["مش لاقي المشروع أو الوحدة دي.", "That project or unit wasn't found."],
  notes_full: ["الملاحظات وصلت للحد (4000 حرف). اختصرها من صفحة المشروع الأول.", "These notes are full (4,000 characters). Trim them on the project page first."],
  ai: ["المساعد مش متاح دلوقتي، جرب كمان شوية.", "The assistant is not available right now; try again shortly."]
};

/** Grouped results for a question (services/projectSearch.js; the app asks GET /api/ask/results for the same list). */
async function resultsBlock(pool, broker, query, lang, assets) {
  const r = await ProjectSearch.fromQuery(pool, broker, query, { AI });
  const explicit = {};
  for (const k of ["pmin", "pmax", "amin", "amax", "dmax", "imax", "bed", "units"]) if (query[k] !== undefined && query[k] !== "") explicit[k] = String(query[k]);
  return { data: r, view: resultsView(lang, r, { q: String(query.q || "").trim().slice(0, 500), sort: r.sort, drop: String(query.drop || ""), explicit, base: "/app/ask/results", trackSrc: assets ? assets.url("askTrack.js") : null }) };
}

function answerCard(out, question, lang) {
  const al = out.lang;
  const dates = out.found ? Assistant.datesLine(out.dates || [], al) : "";
  const forClient = out.found && out.dates?.length;
  return html`<section class="card ${out.found ? "notice ok" : ""}" data-assistant-answer data-found="${out.found ? "yes" : "no"}">
  <p class="muted">❓ ${question}</p>
  <p class="pre" data-answer-text>${out.answer}</p>
  ${out.source === "local" ? html`<p class="muted small" data-answer-local>${L(lang, "الرد ده متكتب من بيانات الشركة مباشرة (المساعد الذكي مش متاح دلوقتي).", "This answer is written straight from the agency's data (the AI is not available right now).")}</p>` : ""}
  ${dates ? html`<p class="muted" data-answer-dates>${dates}</p>` : ""}
  ${forClient ? html`<p><a class="btn" href="https://wa.me/?text=${encodeURIComponent(out.answer)}" target="_blank" rel="noopener noreferrer" data-send-whatsapp>📤 ${L(lang, "ابعته على واتساب", "Send on WhatsApp")}</a></p>` : ""}
</section>`;
}

function register(web, { pool, page, assets }) {
  const show = async (req, res, { question = "", out = null, error = null, saved = null, results = null } = {}, status = 200) => {
    const lang = langOf(req);
    const broker = req.session.broker;
    const missed = isManager(broker) ? await Assistant.unanswered(pool, broker) : null;
    const projects = missed?.length ? (await pool.query("SELECT id, name FROM projects WHERE agency_id = $1 AND archived_at IS NULL ORDER BY name LIMIT 200", [broker.agency_id])).rows : [];
    return page(req, res, {
      title: L(lang, "اسأل", "Ask"),
      nav: "ask",
      body: html`<h1>💬 ${L(lang, "اسأل المساعد", "Ask the assistant")}</h1>
<p class="muted">${L(lang, "بيرد من بيانات الشركة بس (المشاريع، الأسعار، البروشور، عملاءك، متابعاتك، الوحدات) ومعاه تاريخ البيانات. لو المعلومة مش عندنا هيقولك كده ومش هيخمّن.", "Answers only from the agency's data (projects, prices, brochures, your clients, follow-ups, units), with the data's date. If we don't have it, it says so and never guesses.")}</p>
${saved ? html`<p class="notice ok card" data-info-saved>✅ ${L(lang, `اتضافت المعلومة على ${saved.kind === "unit" ? "الوحدة" : "المشروع"} ${saved.name}. المساعد هيستخدمها من دلوقتي.`, `Added to ${saved.kind === "unit" ? "unit" : "project"} ${saved.name}. The assistant will use it from now on.`)}</p>` : ""}
${error ? html`<p class="notice bad card" data-assistant-error="${error}">${AiBlock.BLOCKS.includes(error) ? AiBlock.text(error, lang, { owner: isAgencyOwner(req.session.broker) }) : (ERRORS[error] || ERRORS.ai)[lang === "en" ? 1 : 0]}</p>` : ""}
<form method="post" action="/app/ask" class="card stack" data-search-form>
  <label>${L(lang, "سؤالك", "Your question")}
  <textarea name="q" rows="3" maxlength="${A.MAX_QUESTION}" required placeholder="${L(lang, "مثلا: امتى استلام بادية؟ مين من عملائي عايز 3 أوض في زايد؟ ورايا إيه النهارده؟", "e.g. When is Badya's delivery? Which of my clients want 3 bedrooms in Zayed? What's due today?")}">${question}</textarea></label>
  <button type="submit" data-ai="ask" data-no-tg-main>${L(lang, "اسأل", "Ask")} <span class="btn-cost">(${L(lang, `${Credits.costOf("assistant")} رصيد`, `${Credits.costOf("assistant")} credits`)})</span><span class="spin" aria-hidden="true"></span></button>
</form>
${out ? answerCard(out, question, lang) : ""}
${results || ""}
${missed
  ? html`<section class="card" data-unanswered><h2>${L(lang, "أسئلة ملقيناش ردها في بياناتنا", "Questions our data could not answer")}</h2>
  <p class="muted">${L(lang, "ضيف المعلومة دي للمشروع أو الوحدة عشان المساعد يرد عليها المرة الجاية.", "Add this information to the project or unit so the assistant can answer next time.")}</p>
  ${missed.length
    ? html`<ul>${missed.map(
        (m) => html`<li data-question="${m.id}">${day(m.created_at)} · ${m.broker_name || "—"}: ${m.question}
    <details><summary>➕ ${L(lang, "ضيف الإجابة", "Add the answer")}</summary>
      <form method="post" action="/app/ask/info" class="stack">
        <input type="hidden" name="question" value="${m.id}">
        <label>${L(lang, "المشروع", "Project")} <select name="project"><option value="">—</option>${projects.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select></label>
        <label>${L(lang, "أو كود الوحدة", "Or unit code")} <input name="unit" dir="ltr" maxlength="40" placeholder="NH-V12"></label>
        <label>${L(lang, "المعلومة", "The information")} <textarea name="text" rows="2" maxlength="500" required></textarea></label>
        <button type="submit" class="secondary">${L(lang, "احفظ", "Save")}</button>
      </form>
    </details></li>`
      )}</ul>`
    : html`<p class="muted">${L(lang, "مفيش.", "None.")}</p>`}
</section>`
  : ""}`
    }, status);
  };

  web.get("/ask", (req, res) => show(req, res));

  // "Wrong results?" on the grouped list: the same report as unit search's "Wrong search" (both readings are in the log row; the owner reviews it).
  web.post("/ask/report", async (req, res) => {
    const SearchLog = require("../../services/searchLog");
    const r = await SearchLog.report(pool, req.session.broker, String(req.body.sl || ""), req.body.note);
    if (r.ok) await SearchLog.action(pool, req.session.broker, String(req.body.sl), "report");
    const back = String(req.get("Referer") || "");
    const m = back.match(/^https?:\/\/[^/]+(\/app\/ask.*)$/);
    return res.redirect(303, m ? m[1] : "/app/ask");
  });
  // What the broker did after the results (a click on a sort, a chip, a page, a project): sent by script (navigator.sendBeacon), nothing else waits on it.
  web.post("/ask/action", async (req, res) => {
    const r = await require("../../services/searchLog").action(pool, req.session.broker, String(req.body.sl || ""), String(req.body.action || ""), req.body.detail);
    return res.status(r.ok ? 204 : 404).end();
  });

  web.post("/ask/info", async (req, res) => {
    const lang = langOf(req);
    const r = await Assistant.addInfo(pool, req.session.broker, { questionId: req.body.question, project: req.body.project, unit: req.body.unit, text: req.body.text });
    if (r.error === "forbidden") return res.status(403).type("text/plain").send(L(lang, "للمديرين بس", "Managers only"));
    if (r.error) return show(req, res, { error: r.error === "empty" ? "empty" : r.error === "notes_full" ? "notes_full" : "info" }, 400);
    return show(req, res, { saved: r.target });
  });

  web.post("/ask", async (req, res) => {
    const question = String(req.body.q || "").trim().slice(0, A.MAX_QUESTION);
    if (!question) return show(req, res, { error: "empty" }, 400);
    const broker = req.session.broker;
    const lang = langOf(req);
    // The AI answers first and code writes the same kind of line from the results second; both are kept for the comparison. With the AI off or out of
    // credit the line written from the results is the answer.
    // The results are read first (once, logged) and given to Ask, so the answer and the list never disagree.
    const block = await resultsBlock(pool, broker, { q: question }, lang, assets).catch(() => null);
    const out = await Assistant.ask(pool, broker, question, { channel: "web", results: block ? block.data : null });
    const local = block ? AnswerLine.line(block.data, lang) : "";
    // No question_id = the AI did not answer (the older code-only answers have none): the line written from the results stands in.
    if (out.error || !out.question_id) {
      if (out.error === "empty" || !block || !block.data.total_projects) return out.error ? show(req, res, { question, error: out.error }, out.error === "empty" ? 400 : 200) : show(req, res, { question, out, results: block && block.view });
      await Assistant.noteAnswers(pool, broker, { question, local, source: "local", logId: block.data.log_id, found: true });
      return show(req, res, { question, out: { answer: local, found: true, lang, dates: [], source: "local" }, results: block.view });
    }
    await Assistant.noteAnswers(pool, broker, { questionId: out.question_id, ai: out.answer, local, source: "ai", logId: block && block.data.log_id });
    return show(req, res, { question, out, results: block && block.view });
  });

  // The grouped results alone: pages, sort and removable filter chips (links, so no script is needed).
  web.get("/ask/results", async (req, res) => {
    const question = String(req.query.q || "").trim().slice(0, A.MAX_QUESTION);
    if (!question) return show(req, res, { error: "empty" }, 400);
    const block = await resultsBlock(pool, req.session.broker, { ...req.query, q: question }, langOf(req), assets);
    return show(req, res, { question, results: block.view });
  });
}

module.exports = { register };
