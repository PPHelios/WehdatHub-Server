// web/routes/globalProjects.js — The global project library. Managers (/app/library) browse the published projects and
// copy one into their agency; the CRM owner (/app/owner/library) publishes or hides each one. Copies are the agency's own.
"use strict";

const Dash = require("../../services/dashboards");
const Lib = require("../../services/globalProjects");
const { isManager } = require("../../lib/authz");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");

const facts = (g) => [g.developer, g.region, g.status, g.unit_types].filter(Boolean).join(" · ");

function register(web, { pool, page }) {
  // The library file is read once per process, the first time someone opens the library (never at start-up).
  let synced = null;
  const syncOnce = () => (synced ||= Lib.syncFile(pool).catch((e) => { synced = null; console.warn("Library sync failed:", e.message); }));
  const guard = (check, fn) => async (req, res, next) => {
    try {
      if (!check(req.session.broker)) return res.status(404).send("Not found");
      return await fn(req, res, langOf(req));
    } catch (e) {
      return next(e);
    }
  };

  web.get("/library", guard(isManager, async (req, res, lang) => {
    await syncOnce();
    const items = await Lib.list(pool, { agencyId: req.session.broker.agency_id });
    const msg = { copied: L(lang, "اتنسخ لمشاريعك.", "Copied to your projects."), duplicate: L(lang, "المشروع ده عندك بالفعل.", "You already have this project.") }[req.query.msg];
    return page(req, res, { title: L(lang, "مكتبة المشاريع", "Project library"), nav: "catalogue", body: html`<h1>📚 ${L(lang, "مكتبة المشاريع", "Project library")}</h1>
${msg ? html`<p class="ok" role="status">${msg}</p>` : ""}
<p class="muted">${L(lang, "معلومات عامة بس. بتنسخ المشروع لمشاريعك وتعدّل عليه براحتك، ومحدش غيرك بيشوف التعديل.", "General facts only. Copy a project into yours and edit it freely; nobody else sees your changes.")}</p>
${items.length ? html`<ul class="stack">${items.map((g) => html`<li class="card stack"><strong>${g.name}</strong> <span class="muted">${facts(g)}</span>
  ${g.facts ? html`<p>${g.facts}</p>` : ""}
  ${g.used ? html`<span class="muted">${L(lang, "عندك نسخة", "You have a copy")}</span>` : html`<form method="post" action="/app/library/${g.id}/use"><button type="submit" class="small">${L(lang, "استخدم", "Use")}</button></form>`}</li>`)}</ul>` : html`<p class="muted">${L(lang, "المكتبة فاضية لسه.", "The library is empty for now.")}</p>`}` });
  }));

  web.post("/library/:id/use", guard(isManager, async (req, res) => {
    const r = await Lib.use(pool, req.session.broker, req.params.id);
    if (r.ok) return res.redirect(303, `/app/catalogue/projects/${r.project.id}`);
    return res.redirect(303, `/app/library?msg=${r.error === "duplicate" ? "duplicate" : "missing"}`);
  }));

  web.get("/owner/library", guard(Dash.isOwner, async (req, res, lang) => {
    await syncOnce();
    const items = await Lib.list(pool);
    return page(req, res, { title: L(lang, "مكتبة المشاريع", "Project library"), nav: "ownerlibrary", body: html`<h1>📚 ${L(lang, "مكتبة المشاريع", "Project library")}</h1>
<p class="muted">${L(lang, "راجع كل مشروع وانشره. المنشور بس بيظهر للمكاتب.", "Check each project, then publish it. Only published ones show to agencies.")}</p>
<ul class="stack">${items.map((g) => html`<li class="card stack"><strong>${g.name}</strong> <span class="muted">${facts(g)}</span>
  ${g.facts ? html`<p>${g.facts}</p>` : ""}
  <form method="post" action="/app/owner/library/${g.id}/${g.published ? "hide" : "publish"}"><button type="submit" class="${g.published ? "secondary " : ""}small">${g.published ? L(lang, "اخفِ", "Hide") : L(lang, "انشر", "Publish")}</button></form></li>`)}</ul>` });
  }));

  for (const [action, value] of [["publish", true], ["hide", false]]) {
    web.post(`/owner/library/:id/${action}`, guard(Dash.isOwner, async (req, res) => {
      await Lib.setPublished(pool, req.params.id, value);
      return res.redirect(303, "/app/owner/library");
    }));
  }
}

module.exports = { register };
