// web/routes/assistant.js — "Ask" (Release B, C10 + N1): the assistant on the website. The broker asks about a project,
// their clients, follow-ups or units; the answer comes from the agency's own data only, with the data dates, or says it
// is not in our data. A web answer (owner switch) is shown apart, labelled unverified, with its source links. A found
// answer about a project has a "Send on WhatsApp" button. Managers also see the recent questions the data could not
// answer, so they know what to add. Logic lives in services/assistant.js.
"use strict";

const Assistant = require("../../services/assistant");
const ProjectAnswer = require("../../services/projectAnswer");
const Q = require("../../domain/searchQuery");
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

const money = (n) => (n == null ? "-" : Number(n).toLocaleString("en-US"));
const PER_PAGE = 10;
const CHIPS = {
  place: { keys: ["locations", "places", "place_terms"], text: (f, lang) => [...(f.place_terms || []), ...(f.locations || [])].filter(Boolean).join("، ") && `${L(lang, "المكان", "Place")}: ${[...(f.place_terms || []), ...(f.locations || [])].join("، ")}` },
  area: { keys: ["area_min", "area_max"], text: (f, lang) => (f.area_min != null || f.area_max != null) && `${L(lang, "المساحة", "Area")}: ${f.area_min != null && f.area_max != null ? `${f.area_min}-${f.area_max}` : f.area_min != null ? `${L(lang, "أكتر من", "at least")} ${f.area_min}` : `${L(lang, "لحد", "up to")} ${f.area_max}`}` },
  price: { keys: ["price_min", "price_max"], text: (f, lang) => (f.price_min != null || f.price_max != null) && `${L(lang, "السعر", "Price")}: ${f.price_min != null ? money(f.price_min) : ""}${f.price_min != null && f.price_max != null ? " - " : ""}${f.price_max != null ? `${L(lang, "لحد", "up to")} ${money(f.price_max)}` : ""}` },
  down: { keys: ["max_down_payment"], text: (f, lang) => f.max_down_payment != null && `${L(lang, "المقدم لحد", "Down up to")} ${money(f.max_down_payment)}` },
  inst: { keys: ["max_installment"], text: (f, lang) => f.max_installment != null && `${L(lang, "القسط لحد", "Installment up to")} ${money(f.max_installment)}` }
};

/** Grouped results for a question: chips (each removable), sort, project cards with their fitting offers, pages. */
async function resultsBlock(pool, broker, q, { page = 1, sort = "best", drop = "" } = {}, lang) {
  const f = Q.fallbackParse(q).filters;
  const dropped = new Set(String(drop).split(",").filter((k) => CHIPS[k]));
  for (const k of dropped) for (const key of CHIPS[k].keys) f[key] = Array.isArray(f[key]) ? [] : null;
  const chips = Object.entries(CHIPS).filter(([k]) => !dropped.has(k)).map(([k, c]) => [k, c.text(f, lang)]).filter(([, t]) => t);
  const r = await ProjectAnswer.projectResults(pool, broker.agency_id, f, { page, perPage: PER_PAGE, sort: sort === "cheap" ? "cheap" : "best" });
  const base = (extra) => `/app/ask/results?${new URLSearchParams({ q, sort, drop: [...dropped].join(","), page: "1", ...extra }).toString()}`;
  const dropLink = (k) => base({ drop: [...dropped, k].join(",") });
  const stat = r.total_projects ? `${r.total_projects} ${L(lang, "مشروع", "projects")} · ${r.total_offers} ${L(lang, "اختيار", "options")}` : L(lang, "مفيش مشروع بالمواصفات دي", "No project matches");
  return html`<section class="stack" data-ask-results>
  <div class="row" style="flex-wrap:wrap;gap:8px">${chips.map(([k, t]) => html`<a class="pill" data-chip="${k}" href="${dropLink(k)}">${t} ✕</a>`)}${[...dropped].length ? html`<a class="pill muted" href="${base({ drop: "" })}">${L(lang, "رجّع الفلاتر", "Reset filters")}</a>` : ""}</div>
  <div class="row" style="justify-content:space-between;align-items:center"><strong data-results-count>${stat}</strong>
    <span><a class="pill${sort === "best" ? " on" : ""}" href="${base({ sort: "best" })}">${L(lang, "الأنسب", "Best match")}</a> <a class="pill${sort === "cheap" ? " on" : ""}" href="${base({ sort: "cheap" })}">${L(lang, "الأرخص", "Cheapest")}</a></span></div>
  ${r.projects.map((g) => html`<article class="card stack" data-ask-project>
    <div><strong>${g.project.name}</strong><div class="muted small">${[g.project.district, g.project.city].filter(Boolean).join(" · ")}</div></div>
    <ul>${g.offers.slice(0, 3).map((u) => html`<li>${u.area != null ? `${u.area} m²` : L(lang, "المساحة مش مكتوبة", "size not written")}${u.floor ? ` · ${L(lang, "الدور", "floor")} ${u.floor}` : ""} · <strong>${money(u.price)}</strong>${u.down != null ? ` · ${L(lang, "مقدم", "down")} ${money(u.down)}` : ""}${(u.monthly ?? u.monthly_est) != null ? ` · ${L(lang, "قسط", "monthly")} ${money(u.monthly ?? u.monthly_est)}` : ""}</li>`)}</ul>
    ${g.offers.length > 3 ? html`<p class="muted small">+ ${g.offers.length - 3} ${L(lang, "اختيارات تانية", "more options")}</p>` : ""}
    <div class="row"><a class="btn" href="https://wa.me/?text=${encodeURIComponent(ProjectAnswer.clientText(g.offers.slice(0, 5).map((unit) => ({ project: g.project, unit })), lang))}" target="_blank" rel="noopener noreferrer">📤 ${L(lang, "ابعت للعميل", "Send to client")}</a></div>
  </article>`)}
  ${r.pages > 1 ? html`<nav class="row" aria-label="${L(lang, "الصفحات", "Pages")}">${Array.from({ length: r.pages }, (_, i) => html`<a class="pill${i + 1 === r.page ? " on" : ""}" href="${base({ page: String(i + 1) })}">${i + 1}</a>`)}</nav>` : ""}
</section>`;
}

function answerCard(out, question, lang) {
  const al = out.lang;
  const dates = out.found ? Assistant.datesLine(out.dates || [], al) : "";
  const forClient = out.found && out.dates?.length;
  return html`<section class="card ${out.found ? "notice ok" : ""}" data-assistant-answer data-found="${out.found ? "yes" : "no"}">
  <p class="muted">❓ ${question}</p>
  <p class="pre" data-answer-text>${out.answer}</p>
  ${dates ? html`<p class="muted" data-answer-dates>${dates}</p>` : ""}
  ${forClient ? html`<p><a class="btn" href="https://wa.me/?text=${encodeURIComponent(out.answer)}" target="_blank" rel="noopener noreferrer" data-send-whatsapp>📤 ${L(lang, "ابعته على واتساب", "Send on WhatsApp")}</a></p>` : ""}
</section>`;
}

function register(web, { pool, page }) {
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
${error ? html`<p class="notice bad card" data-assistant-error="${error}">${["quota", "daily", "off"].includes(error) ? AiBlock.text(error, lang, { owner: isAgencyOwner(req.session.broker) }) : (ERRORS[error] || ERRORS.ai)[lang === "en" ? 1 : 0]}</p>` : ""}
<form method="post" action="/app/ask" class="card stack" data-search-form>
  <label>${L(lang, "سؤالك", "Your question")}
  <textarea name="q" rows="3" maxlength="${A.MAX_QUESTION}" required placeholder="${L(lang, "مثلا: امتى استلام بادية؟ مين من عملائي عايز 3 أوض في زايد؟ ورايا إيه النهارده؟", "e.g. When is Badya's delivery? Which of my clients want 3 bedrooms in Zayed? What's due today?")}">${question}</textarea></label>
  <button type="submit" data-ai="ask" data-no-tg-main>${L(lang, "اسأل", "Ask")}<span class="spin" aria-hidden="true"></span></button>
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
    const out = await Assistant.ask(pool, req.session.broker, question, { channel: "web" });
    if (out.error) return show(req, res, { question, error: out.error }, out.error === "empty" ? 400 : 200);
    const results = await resultsBlock(pool, req.session.broker, question, {}, langOf(req)).catch(() => null);
    return show(req, res, { question, out, results });
  });

  // The grouped results alone: pages, sort and removable filter chips (links, so no script is needed).
  web.get("/ask/results", async (req, res) => {
    const question = String(req.query.q || "").trim().slice(0, A.MAX_QUESTION);
    if (!question) return show(req, res, { error: "empty" }, 400);
    const results = await resultsBlock(pool, req.session.broker, question, { page: Number(req.query.page) || 1, sort: String(req.query.sort || "best"), drop: String(req.query.drop || "") }, langOf(req));
    return show(req, res, { question, results });
  });
}

module.exports = { register };
