// api/owners.js — Unit owner profiles for the app: the same services as the website (services/unitOwners.js, privatePortfolio.js),
// so the same visibility and role rules apply. Route order matters: /owners/requests before /owners/:id.
"use strict";

const Owners = require("../services/unitOwners");
const Portfolio = require("../services/privatePortfolio");
const Store = require("../lib/listingStore");
const Vis = require("../lib/visibility");
const ReadCaps = require("../lib/readCaps");
const { isDataEntry, isAgencyOwner } = require("../lib/authz");

const STATUS = { forbidden: 403, not_found: 404, duplicate: 409 };
const fail = (res, error, extra = {}) => res.status(STATUS[error] || 422).json({ error, ...extra });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function register(api, { pool }) {
  const gate = async (req, res, next) => {
    const b = req.session.broker;
    if (isDataEntry(b) && !(await Owners.dataEntryOwnersOn(pool, b.agency_id))) return res.status(403).json({ error: "forbidden" });
    return next();
  };

  api.get("/owners", gate, async (req, res) => {
    const b = req.session.broker;
    const page = Math.max(0, parseInt(req.query.page, 10) || 0);
    const list = await Owners.listFor(pool, b, { q: String(req.query.q || "").slice(0, 80), limit: 50, offset: page * 50, onlyPrivate: req.query.private === "1" && isAgencyOwner(b) });
    const cap = await ReadCaps.takeOwnerPhones(pool, b, list.rows.filter((o) => (o.phones || []).length).length, { channel: "app", ref: "owner_list" });
    if (!cap.allowed) return res.set("Retry-After", String(cap.retryAfterSec)).status(429).json({ error: "daily_cap" });
    res.json({ items: list.rows, more: list.more });
  });

  api.get("/owners/requests", gate, async (req, res) => res.json({ items: await Owners.pendingFor(pool, req.session.broker) }));

  api.post("/owners/requests/:id", async (req, res) => {
    const r = await Owners.decideRequest(pool, req.session.broker, req.params.id, req.body?.decision === "approve");
    return r.error ? fail(res, r.error) : res.json({ ok: true });
  });

  api.get("/owners/:id", gate, async (req, res) => {
    if (!UUID.test(req.params.id)) return fail(res, "not_found");
    const b = req.session.broker;
    const owner = await Owners.getFor(pool, b, req.params.id);
    if (!owner) return fail(res, "not_found");
    if ((owner.phones || []).length) {
      const cap = await ReadCaps.takeOwnerPhones(pool, b, 1, { channel: "app", ref: owner.code || null });
      if (!cap.allowed) return res.set("Retry-After", String(cap.retryAfterSec)).status(429).json({ error: "daily_cap" });
    }
    const [events, lead] = await Promise.all([Owners.history(pool, b, owner.id), isDataEntry(b) ? null : Owners.leadFor(pool, b, owner)]);
    return res.json({ owner, events, lead: lead ? { ref: lead.ref } : null });
  });

  api.post("/owners/:id", gate, async (req, res) => {
    const r = await Owners.edit(pool, req.session.broker, req.params.id, req.body || {});
    return r.error ? fail(res, r.error, r.existingId ? { existingId: r.existingId } : {}) : res.json({ ok: true, nameRequested: Boolean(r.name_requested) });
  });

  api.post("/owners/:id/delete", async (req, res) => {
    const r = await Owners.remove(pool, req.session.broker, req.params.id);
    return r.error ? fail(res, r.error) : res.json({ ok: true });
  });

  // Agency owner only: VIP on or off. On: also hides the ticked units (codes) and the owner's details on units.
  api.post("/owners/:id/portfolio", async (req, res) => {
    const b = req.session.broker;
    if (!isAgencyOwner(b)) return fail(res, "forbidden");
    const on = req.body?.value === true || req.body?.value === "1";
    const r = await Portfolio.setPrivate(pool, b, "owner", req.params.id, on);
    if (r.error) return fail(res, r.error);
    if (on) {
      const ticked = [].concat(req.body?.units || []).map(String);
      const owned = (await pool.query(`SELECT id, code FROM listings WHERE owner_id = $1 AND agency_id = $2 AND ${Vis.units("listings")}`, [req.params.id, b.agency_id])).rows;
      for (const u of owned.filter((x) => ticked.includes(x.code))) await Portfolio.setPrivate(pool, b, "unit", u.id, true);
      await Owners.hideOwnerDetails(pool, b.agency_id, req.params.id);
    } else await Owners.restoreOwnerDetails(pool, b.agency_id, req.params.id);
    return res.json({ ok: true, private: on });
  });

  // Agency owner only: one unit or lead private or public.
  api.post("/portfolio/:kind/:id", async (req, res) => {
    const b = req.session.broker;
    if (!isAgencyOwner(b)) return fail(res, "forbidden");
    const r = await Portfolio.setPrivate(pool, b, req.params.kind, req.params.id, req.body?.value === true || req.body?.value === "1");
    return r.error ? fail(res, r.error) : res.json(r);
  });

  // A manager moves a unit to another owner: a lead who bought it, or a new person.
  api.post("/units/:code/owner", async (req, res) => {
    const b = req.session.broker;
    const listing = await Store.findByCode(pool, b.agency_id, req.params.code);
    if (!listing) return fail(res, "not_found");
    const r = await Owners.reassign(pool, b, listing, { leadRef: String(req.body?.lead || "").trim() || null, name: req.body?.name, phone: req.body?.phone });
    return r.error ? fail(res, r.error) : res.json({ ok: true });
  });
}

module.exports = { register };
