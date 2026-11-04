// web/routes/owners.js — Unit owner profiles (services/unitOwners.js): the list, one profile with its units and history,
// manager edits, and a manager moving a unit to another owner (a profile, a lead who bought it, or a new person).
"use strict";

const Owners = require("../../services/unitOwners");
const Store = require("../../lib/listingStore");
const Phone = require("../../domain/phone");
const { isManager, isAgencyOwner } = require("../../lib/authz");
const Portfolio = require("../../services/privatePortfolio");
const Vis = require("../../lib/visibility");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const stamp = (d, lang) => new Date(d).toLocaleString(lang === "en" ? "en-GB" : "ar-EG", { timeZone: "Africa/Cairo", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const PAGE = 50;

const eventLine = (e, lang) => {
  const d = e.data || {};
  switch (e.kind) {
    case "created":
      return L(lang, "🆕 اتسجل", "🆕 Added");
    case "edited":
      return L(lang, `✏️ الاسم: ${d.name || ""}`, `✏️ Name: ${d.name || ""}`);
    case "note":
      return `📝 ${d.text || L(lang, "(اتمسحت الملاحظة)", "(note cleared)")}`;
    case "flag":
      return `🚩 ${d.to || L(lang, "(اتشالت العلامة)", "(flag cleared)")}`;
    case "unit_linked":
      return L(lang, `🏠 وحدة اتربطت: ${d.code}`, `🏠 Unit linked: ${d.code}`);
    case "unit_moved_in":
      return L(lang, `⬅️ وحدة اتنقلت له: ${d.code}`, `⬅️ Unit moved to them: ${d.code}`);
    case "unit_moved_out":
      return L(lang, `➡️ وحدة اتنقلت منه: ${d.code}`, `➡️ Unit moved away: ${d.code}`);
    default:
      return e.kind;
  }
};

/** The block on a unit page: its owner (linked) and, for managers, the form that moves the unit to another owner. */
async function unitOwnerBlock(pool, viewer, listing, lang, csrf, notice = null) {
  const owner = listing.owner_id ? await Owners.getFor(pool, viewer, listing.owner_id) : null;
  const move = isManager(viewer)
    ? html`<details><summary>${L(lang, "نقل الوحدة لمالك تاني", "Move to another owner")}</summary>
  <form method="post" action="/app/units/${encodeURIComponent(listing.code)}/owner" class="stack" data-owner-move><input type="hidden" name="_csrf" value="${csrf}">
    <label>${L(lang, "كود العميل اللي اشتراها (L-0042)", "Lead who bought it (L-0042)")}<input name="lead" dir="ltr" placeholder="L-0042"></label>
    <p class="muted small">${L(lang, "أو مالك جديد:", "or a new owner:")}</p>
    <label>${L(lang, "الاسم", "Name")}<input name="name" maxlength="120"></label>
    <label>${L(lang, "الموبايل", "Mobile")}<input name="phone" inputmode="tel" dir="ltr"></label>
    <button type="submit" class="secondary">${L(lang, "انقل", "Move")}</button>
  </form></details>`
    : "";
  if (!owner && !move) return "";
  return html`<p data-unit-owner>${notice || ""}${owner ? html`👤 ${L(lang, "المالك", "Owner")}: <a href="/app/owners/${owner.id}">${owner.name || L(lang, "بدون اسم", "No name")}</a>` : ""}</p>${move}`;
}

function register(web, { pool, page }) {
  web.get("/owners", async (req, res) => {
    const { broker } = req.session;
    const lang = langOf(req);
    const n = Math.max(0, parseInt(req.query.page, 10) || 0);
    const q = String(req.query.q || "").slice(0, 80);
    const onlyPrivate = req.query.private === "1" && isAgencyOwner(broker);
    const list = await Owners.listFor(pool, broker, { q, limit: PAGE, offset: n * PAGE, onlyPrivate });
    return page(req, res, {
      title: L(lang, "المُلّاك", "Owners"),
      nav: "units",
      body: html`<h1>👤 ${L(lang, "المُلّاك", "Owners")}</h1>
<form method="get" action="/app/owners" class="row"><input name="q" value="${q}" placeholder="${L(lang, "اسم أو موبايل", "Name or mobile")}" aria-label="${L(lang, "بحث", "Search")}"><button type="submit" class="secondary">${L(lang, "بحث", "Search")}</button></form>
${isAgencyOwner(broker) ? html`<p><a class="pill-link${onlyPrivate ? " on" : ""}" href="/app/owners?private=${onlyPrivate ? "" : "1"}">⭐ ${L(lang, "VIP", "VIP")}</a></p>` : ""}
${list.rows.length
  ? html`<ul class="stack" data-owners>${list.rows.map((o) => html`<li class="card" data-owner="${o.id}"><a href="/app/owners/${o.id}"><b>${o.name || L(lang, "بدون اسم", "No name")}</b></a> <span class="muted small" dir="ltr">${(o.phones || []).map((p) => Phone.displayPhone(`+${p}`)).join(" · ")}</span> <span class="chip">${o.unit_count} ${L(lang, "وحدة", "unit(s)")}</span>${o.flag ? html` <span class="badge">🚩 ${o.flag}</span>` : ""}${o.is_private ? html` <span class="badge">⭐ ${L(lang, "VIP", "VIP")}</span>` : ""}</li>`)}</ul>`
  : html`<p class="muted">${L(lang, "مفيش مُلّاك لسه.", "No owners yet.")}</p>`}
<p class="row">${n > 0 ? html`<a href="/app/owners?page=${n - 1}&q=${encodeURIComponent(q)}">${L(lang, "→ الأحدث", "← Newer")}</a>` : ""} ${list.more ? html`<a href="/app/owners?page=${n + 1}&q=${encodeURIComponent(q)}">${L(lang, "الأقدم ←", "Older →")}</a>` : ""}</p>`
    });
  });

  web.get("/owners/:id", async (req, res, next) => {
    const { broker } = req.session;
    const lang = langOf(req);
    const owner = await Owners.getFor(pool, broker, req.params.id);
    if (!owner) return next();
    const manager = isManager(broker);
    const lead = await Owners.leadFor(pool, broker, owner);
    const events = await Owners.history(pool, broker, owner.id);
    // The brokers who linked or moved a unit to this owner, in the order they first did.
    const handledBy = [...new Set(events.filter((e) => ["created", "unit_linked", "unit_moved_in"].includes(e.kind) && e.broker_name).reverse().map((e) => e.broker_name))];
    return page(req, res, {
      title: owner.name || L(lang, "مالك", "Owner"),
      nav: "units",
      body: html`<article class="card stack" data-owner-profile="${owner.id}">
  ${req.query.saved ? html`<p class="notice ok">✅ ${L(lang, "اتحفظ", "Saved")}</p>` : ""}
  <h1>👤 ${owner.name || L(lang, "بدون اسم", "No name")}</h1>
  <p dir="ltr">${(owner.phones || []).map((p) => html`<a href="${Phone.telUrl(`+${p}`)}">${Phone.displayPhone(`+${p}`)}</a> `)}</p>
  ${owner.is_private ? html`<p class="badge">⭐ ${L(lang, "VIP", "VIP")}</p>` : ""}
  ${owner.flag ? html`<p>🚩 ${owner.flag}</p>` : ""}
  ${owner.notes ? html`<p>${owner.notes}</p>` : ""}
  ${lead ? html`<p data-owner-lead>🔗 ${L(lang, "هو كمان عميل", "Also a lead")}: <a href="/app/leads/L-${String(lead.ref).padStart(4, "0")}">L-${String(lead.ref).padStart(4, "0")}</a></p>` : ""}
  <h2>${L(lang, "وحداته", "Units")}</h2>
  <ul data-owner-units>${owner.units.map((u) => html`<li><a href="/app/units/${encodeURIComponent(u.code)}">${u.code}</a> · ${u.compound || ""} · ${u.status}${u.is_private ? " 🔒" : ""}</li>`)}</ul>
  ${isAgencyOwner(broker) && owner.is_private ? html`<form method="post" action="/app/owners/${owner.id}/portfolio" class="row" data-portfolio><input type="hidden" name="_csrf" value="${req.session.csrf}"><input type="hidden" name="value" value="0"><button type="submit" class="secondary">${L(lang, "⭐ شيل الـ VIP", "Remove VIP")}</button></form>` : ""}
  ${isAgencyOwner(broker) && !owner.is_private ? html`<form method="post" action="/app/owners/${owner.id}/portfolio" class="stack" data-portfolio><input type="hidden" name="_csrf" value="${req.session.csrf}"><input type="hidden" name="value" value="1">
    <p class="muted small">${L(lang, "الـ VIP بيخفي المالك وبياناته من كل حد غيرك. اختار الوحدات اللي تتخفي كمان:", "VIP hides the owner and their details from everyone but you. Choose which of their units to hide too:")}</p>
    ${owner.units.map((u) => html`<label class="row"><input type="checkbox" name="units" value="${u.code}" checked> ${u.code}${u.is_private ? " 🔒" : ""}</label>`)}
    <button type="submit" class="secondary">${L(lang, "⭐ خليه VIP", "Make VIP")}</button></form>` : ""}
  ${owner.canEdit
    ? html`<details><summary>${L(lang, "تعديل", "Edit")}</summary>
  <form method="post" action="/app/owners/${owner.id}" class="stack" data-owner-edit><input type="hidden" name="_csrf" value="${req.session.csrf}">
    <label>${L(lang, "الاسم", "Name")}<input name="name" maxlength="120" value="${owner.name || ""}"></label>
    <label>${L(lang, "علامة", "Flag")}<input name="flag" maxlength="200" value="${owner.flag || ""}"></label>
    <label>${L(lang, "ملاحظات", "Notes")}<textarea name="notes" rows="3" maxlength="2000">${owner.notes || ""}</textarea></label>
    <button type="submit">${L(lang, "حفظ", "Save")}</button>
  </form>
  ${manager ? html`<form method="post" action="/app/owners/${owner.id}/delete" data-confirm="${L(lang, "متأكد؟ الوحدات هتفضل من غير مالك.", "Sure? The units stay, without an owner.")}"><input type="hidden" name="_csrf" value="${req.session.csrf}"><button type="submit" class="secondary">🗑️ ${L(lang, "امسح", "Delete")}</button></form>` : ""}</details>`
    : ""}
  <h2>${L(lang, "السجل", "History")}</h2>
  ${handledBy.length ? html`<p data-owner-handled>🤝 ${L(lang, "اتعامل معاه", "Handled by")}: ${handledBy.join(" · ")}</p>` : ""}
  <ul data-owner-history>${events.map((e) => html`<li>${stamp(e.created_at, lang)} ${eventLine(e, lang)}${e.broker_name ? ` · ${e.broker_name}` : ""}</li>`)}</ul>
</article>`
    });
  });

  web.post("/owners/:id", async (req, res, next) => {
    const r = await Owners.edit(pool, req.session.broker, req.params.id, req.body);
    if (r.error === "forbidden") return res.status(403).send(L(langOf(req), "مش مسموحلك تعدّل ده.", "You cannot edit this owner."));
    if (r.error) return next();
    return res.redirect(303, `/app/owners/${req.params.id}?saved=1`);
  });

  // The agency owner marks a profile private or public again.
  // Making a profile VIP also hides the owner's name and phone on every unit, and the units ticked on the form (the owner's
  // own units; the others stay as they are). Removing VIP puts those details back on the units.
  web.post("/owners/:id/portfolio", async (req, res, next) => {
    const { broker } = req.session;
    if (!isAgencyOwner(broker)) return next();
    const makePrivate = req.body.value === "1";
    const r = await Portfolio.setPrivate(pool, broker, "owner", req.params.id, makePrivate);
    if (r.error) return next();
    if (makePrivate) {
      const ticked = [].concat(req.body.units || []).map(String);
      const owned = (await pool.query(`SELECT id, code FROM listings WHERE owner_id = $1 AND agency_id = $2 AND ${Vis.units("listings")}`, [req.params.id, broker.agency_id])).rows;
      for (const u of owned.filter((x) => ticked.includes(x.code))) await Portfolio.setPrivate(pool, broker, "unit", u.id, true);
      await Owners.hideOwnerDetails(pool, broker.agency_id, req.params.id);
    } else {
      await Owners.restoreOwnerDetails(pool, broker.agency_id, req.params.id);
    }
    return res.redirect(303, `/app/owners/${req.params.id}`);
  });

  web.post("/owners/:id/delete", async (req, res, next) => {
    const r = await Owners.remove(pool, req.session.broker, req.params.id);
    if (r.error === "forbidden") return res.status(403).send(L(langOf(req), "للمديرين بس.", "Managers only."));
    if (r.error) return next();
    return res.redirect(303, "/app/owners");
  });

  // A manager moves a unit to another owner: a lead who bought it, or a new person.
  web.post("/units/:code/owner", async (req, res, next) => {
    const { broker } = req.session;
    const listing = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!listing) return next();
    const r = await Owners.reassign(pool, broker, listing, { leadRef: String(req.body.lead || "").trim() || null, name: req.body.name, phone: req.body.phone });
    if (r.error === "forbidden") return res.status(403).send(L(langOf(req), "للمديرين بس.", "Managers only."));
    const lang = langOf(req);
    if (r.error) {
      const why = { lead: L(lang, "العميل مش موجود أو من غير موبايل.", "Lead not found or it has no mobile."), phone: L(lang, "اكتب موبايل صحيح.", "Enter a valid mobile."), same: L(lang, "ده هو المالك الحالي.", "That is already the owner."), not_found: L(lang, "مش موجود.", "Not found.") }[r.error] || r.error;
      return res.status(422).send(why);
    }
    return res.redirect(303, `/app/units/${encodeURIComponent(listing.code)}`);
  });
}

module.exports = { register, unitOwnerBlock };
