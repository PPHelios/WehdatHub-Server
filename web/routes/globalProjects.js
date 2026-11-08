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

// Search box with name suggestions (a datalist, so it works without script), and previous/next links.
const searchBox = (lang, action, q, suggestions) => html`<form method="get" action="${action}" class="row" role="search" data-library-search>
  <input type="search" name="q" value="${q}" maxlength="80" list="library-suggestions" placeholder="${L(lang, "ابحث باسم المشروع أو المطور", "Search by name or developer")}" aria-label="${L(lang, "بحث", "Search")}">
  <datalist id="library-suggestions">${suggestions.map((n) => html`<option value="${n}"></option>`)}</datalist>
  <button type="submit" class="secondary small">${L(lang, "ابحث", "Search")}</button>
</form>`;
const pager = (lang, action, q, page, pages) => (pages <= 1 ? "" : html`<nav class="row" aria-label="${L(lang, "صفحات", "Pages")}" data-library-pages>
  ${page > 1 ? html`<a href="${action}?q=${encodeURIComponent(q)}&page=${page - 1}">${L(lang, "السابقة", "Previous")}</a>` : ""}
  <span class="muted">${page} / ${pages}</span>
  ${page < pages ? html`<a href="${action}?q=${encodeURIComponent(q)}&page=${page + 1}">${L(lang, "التالية", "Next")}</a>` : ""}
</nav>`);
const askedPage = (req) => Math.max(1, Number.parseInt(req.query.page, 10) || 1);
const askedQ = (req) => String(req.query.q || "").slice(0, 80);
const fieldsForm = (lang, action, g = {}) => html`<form method="post" action="${action}" class="stack" data-library-form>
  <label>${L(lang, "الاسم", "Name")} <input name="name" required maxlength="120" value="${g.name || ""}"></label>
  <label>${L(lang, "المطور", "Developer")} <input name="developer" maxlength="120" value="${g.developer || ""}"></label>
  <label>${L(lang, "المنطقة", "Region")} <input name="region" maxlength="120" value="${g.region || ""}"></label>
  <label>${L(lang, "الحالة", "Status")} <input name="status" maxlength="60" value="${g.status || ""}"></label>
  <label>${L(lang, "أنواع الوحدات", "Unit types")} <input name="unit_types" maxlength="300" value="${g.unit_types || ""}"></label>
  <label>${L(lang, "المساحة (فدان)", "Area (acres)")} <input name="area_acres" inputmode="decimal" dir="ltr" value="${g.area_acres ?? ""}"></label>
  <label>${L(lang, "معلومات عامة", "General facts")} <textarea name="facts" rows="4" maxlength="2000">${g.facts || ""}</textarea></label>
  <button type="submit">${L(lang, "احفظ", "Save")}</button>
</form>`;
const LIB_MSG = (lang) => ({
  created: L(lang, "اتضاف المشروع للمكتبة كمسودة. انشره لما تكون راضي عنه.", "Added to the library as a draft. Publish it when you are happy with it."),
  saved: L(lang, "اتحفظ التعديل. حالة النشر ماتغيرتش.", "Saved. The publish status did not change."),
  empty: L(lang, "الاسم مطلوب.", "A name is required."),
  too_long: L(lang, "فيه خانة أطول من المسموح.", "A field is longer than allowed."),
  area: L(lang, "المساحة لازم تكون رقم.", "Area must be a number."),
  duplicate: L(lang, "فيه مشروع بنفس الاسم في المكتبة.", "A project with this name is already in the library."),
  not_found: L(lang, "مالقيناش المشروع ده.", "That project was not found.")
});

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
    const q = askedQ(req);
    const { items, page, pages, suggestions } = await Lib.listPage(pool, { agencyId: req.session.broker.agency_id, q, page: askedPage(req) });
    const msg = { copied: L(lang, "اتنسخ لمشاريعك.", "Copied to your projects."), duplicate: L(lang, "المشروع ده عندك بالفعل.", "You already have this project.") }[req.query.msg];
    return page(req, res, { title: L(lang, "مكتبة المشاريع", "Project library"), nav: "catalogue", body: html`<h1>📚 ${L(lang, "مكتبة المشاريع", "Project library")}</h1>
${msg ? html`<p class="ok" role="status">${msg}</p>` : ""}
<p class="muted">${L(lang, "معلومات عامة بس. بتنسخ المشروع لمشاريعك وتعدّل عليه براحتك، ومحدش غيرك بيشوف التعديل.", "General facts only. Copy a project into yours and edit it freely; nobody else sees your changes.")}</p>
${searchBox(lang, "/app/library", q, suggestions)}
${items.length ? html`<ul class="stack">${items.map((g) => html`<li class="card stack"><strong>${g.name}</strong> <span class="muted">${facts(g)}</span>
  ${g.facts ? html`<p>${g.facts}</p>` : ""}
  ${g.used ? html`<span class="muted">${L(lang, "عندك نسخة", "You have a copy")}</span>` : html`<form method="post" action="/app/library/${g.id}/use"><button type="submit" class="small">${L(lang, "استخدم", "Use")}</button></form>`}</li>`)}</ul>` : html`<p class="muted">${q ? L(lang, "مفيش مشروع بالاسم ده.", "No project matches that search.") : L(lang, "المكتبة فاضية لسه.", "The library is empty for now.")}</p>`}
${pager(lang, "/app/library", q, page, pages)}` });
  }));

  web.post("/library/:id/use", guard(isManager, async (req, res) => {
    const r = await Lib.use(pool, req.session.broker, req.params.id);
    if (r.ok) return res.redirect(303, `/app/catalogue/projects/${r.project.id}`);
    return res.redirect(303, `/app/library?msg=${r.error === "duplicate" ? "duplicate" : "missing"}`);
  }));

  web.get("/owner/library", guard(Dash.isOwner, async (req, res, lang) => {
    await syncOnce();
    const q = askedQ(req);
    const { items, page, pages, suggestions } = await Lib.listPage(pool, { q, page: askedPage(req) });
    const msg = LIB_MSG(lang)[req.query.msg];
    return page(req, res, { title: L(lang, "مكتبة المشاريع", "Project library"), nav: "ownerlibrary", body: html`<h1>📚 ${L(lang, "مكتبة المشاريع", "Project library")}</h1>
${msg ? html`<p class="${req.query.msg === "created" || req.query.msg === "saved" ? "ok" : "notice bad"} card" role="status">${msg}</p>` : ""}
<p class="muted">${L(lang, "راجع كل مشروع وانشره. المنشور بس بيظهر للمكاتب. التعديل مابينشرش حاجة.", "Check each project, then publish it. Only published ones show to agencies. Editing never publishes.")}</p>
<details class="card"><summary>➕ ${L(lang, "ضيف مشروع للمكتبة", "Add a project to the library")}</summary>${fieldsForm(lang, "/app/owner/library")}</details>
${searchBox(lang, "/app/owner/library", q, suggestions)}
${items.length ? html`<ul class="stack">${items.map((g) => html`<li class="card stack"><strong>${g.name}</strong> <span class="muted">${facts(g)}</span> <span class="muted">${g.published ? L(lang, "منشور", "Published") : L(lang, "مسودة", "Draft")}</span>
  ${g.facts ? html`<p>${g.facts}</p>` : ""}
  <p class="row"><a href="/app/owner/library/${g.id}/edit">${L(lang, "تعديل", "Edit")}</a>
  <form method="post" action="/app/owner/library/${g.id}/${g.published ? "hide" : "publish"}"><button type="submit" class="${g.published ? "secondary " : ""}small">${g.published ? L(lang, "اخفِ", "Hide") : L(lang, "انشر", "Publish")}</button></form></p></li>`)}</ul>` : html`<p class="muted">${q ? L(lang, "مفيش مشروع بالاسم ده.", "No project matches that search.") : L(lang, "المكتبة فاضية لسه.", "The library is empty for now.")}</p>`}
${pager(lang, "/app/owner/library", q, page, pages)}` });
  }));

  web.post("/owner/library", guard(Dash.isOwner, async (req, res) => {
    const r = await Lib.create(pool, req.session.broker, req.body);
    return res.redirect(303, `/app/owner/library?msg=${r.ok ? "created" : r.error || "not_found"}`);
  }));

  web.get("/owner/library/:id/edit", guard(Dash.isOwner, async (req, res, lang) => {
    const g = await Lib.getOne(pool, req.session.broker, req.params.id);
    if (!g) return res.status(404).send("Not found");
    return page(req, res, { title: L(lang, "تعديل المشروع", "Edit project"), nav: "ownerlibrary", body: html`<h1>✏️ ${g.name}</h1>
<p class="muted">${L(lang, "التعديل مابينشرش المشروع. النشر والإخفاء من صفحة المكتبة.", "Editing does not publish. Publish or hide from the library page.")}</p>
${fieldsForm(lang, `/app/owner/library/${g.id}/edit`, g)}
<p><a href="/app/owner/library">${L(lang, "رجوع للمكتبة", "Back to the library")}</a></p>` });
  }));

  web.post("/owner/library/:id/edit", guard(Dash.isOwner, async (req, res) => {
    const r = await Lib.update(pool, req.session.broker, req.params.id, req.body);
    return res.redirect(303, `/app/owner/library?msg=${r.ok ? "saved" : r.error || "not_found"}`);
  }));

  for (const [action, value] of [["publish", true], ["hide", false]]) {
    web.post(`/owner/library/:id/${action}`, guard(Dash.isOwner, async (req, res) => {
      await Lib.setPublished(pool, req.params.id, value);
      return res.redirect(303, "/app/owner/library");
    }));
  }
}

module.exports = { register };
