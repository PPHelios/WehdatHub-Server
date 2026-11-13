// api/deals.js — Deals, commissions, lead sources, portal enquiries and opened links for the app. Same services and rules as the website.
"use strict";

const Leases = require("../services/leases");
const { inputFromForm, correctionFrom } = require("../lib/dealForm");
const Deals = require("../services/deals");
const Commissions = require("../services/commissions");
const Sources = require("../services/leadSources");
const Enquiries = require("../services/portalEnquiries");
const OpenedLinks = require("../services/openedLinks");
const C = require("../domain/commissionTracker");
const P = require("../domain/commissionPeriod");
const Authz = require("../lib/authz");
const { isId } = require("../lib/dealScope");

const PAGE = 20;
const CODE = { forbidden: 403, not_found: 404, conflict: 409 };
const fail = (res, r) => res.status(CODE[r.error] || 422).json({ error: r.error, ...(r.field ? { field: r.field } : {}) });

function register(api, { pool }) {
  const managers = (req, res, next) => (Authz.isManager(req.session.broker) ? next() : res.status(403).json({ error: "forbidden" }));

  api.get("/deals", async (req, res) => {
    const n = Math.max(0, parseInt(req.query.page, 10) || 0);
    const b = req.session.broker;
    const [list, totals] = await Promise.all([Deals.listDeals(pool, b, { status: req.query.status, offset: n * PAGE }), Deals.monthlyTotals(pool, b)]);
    res.json({ items: list.rows, more: list.more, totals, statuses: Deals.STATUSES });
  });

  api.get("/deals/:ref", async (req, res) => {
    const deal = await Deals.getDeal(pool, req.session.broker, req.params.ref);
    if (!deal) return res.status(404).json({ error: "not_found" });
    const editable = Authz.canEditDeal(req.session.broker, deal);
    return res.json({ deal, editable, leasePrompt: editable ? await Leases.promptFor(pool, req.session.broker, deal) : null });
  });

  // Record a deal: the same form fields and the same service as the website (lib/dealForm.js, services/deals.js createDeal).
  api.post("/deals", async (req, res) => {
    const b = req.session.broker;
    const body = req.body || {};
    const input = inputFromForm(body, b);
    if (!input.mode) return res.status(422).json({ error: "commission_missing" });
    const idem = /^[0-9a-f]{16}$/.test(String(body.idem || "")) ? `app:${b.id}:${body.idem}` : null;
    const r = await Deals.createDeal(pool, b, input, { idemKey: idem });
    if (r.ok) return res.json({ ok: true, ref: Deals.refLabel(r.deal.ref), duplicate: !!r.duplicate });
    return res.status(r.error === "forbidden" ? 403 : r.error === "unit_conflict" ? 409 : 422).json({ error: r.error || "failed" });
  });

  // A manager's correction of price, commission and the external share (same as the website's "Correct" box).
  api.post("/deals/:ref/correct", async (req, res) => {
    const b = req.session.broker;
    if (!Authz.isManager(b)) return res.status(403).json({ error: "forbidden" });
    const deal = await Deals.getDeal(pool, b, req.params.ref);
    if (!deal) return res.status(404).json({ error: "not_found" });
    const change = correctionFrom(req.body || {});
    if (!change) return res.status(422).json({ error: "commission_missing" });
    const r = await Deals.updateDeal(pool, b, deal.id, change, { version: (req.body || {}).version ?? deal.version });
    return r.ok || r.unchanged ? res.json({ ok: true }) : r.conflict ? res.status(409).json({ error: "conflict" }) : fail(res, r);
  });

  // Status change for anyone who may edit the deal; the version guards against two people editing at once.
  api.post("/deals/:ref/status", async (req, res) => {
    const b = req.session.broker;
    const deal = await Deals.getDeal(pool, b, req.params.ref);
    if (!deal) return res.status(404).json({ error: "not_found" });
    const r = await Deals.updateDeal(pool, b, deal.id, { status: req.body?.status }, { version: req.body?.version ?? deal.version });
    return r.ok || r.unchanged ? res.json({ ok: true }) : r.conflict ? res.status(409).json({ error: "conflict" }) : fail(res, r);
  });

  api.get("/commissions", async (req, res) => {
    const actor = req.session.broker;
    const manager = Authz.isManager(actor);
    const lead = Authz.isTeamLead(actor);
    const kind = req.query.kind === "developers" ? "developers" : "resale";
    const range = P.periodRange(req.query.period, req.query.at);
    const brokerId = (manager || lead) && isId(req.query.broker) ? req.query.broker : null;
    const teamLeadId = manager && !brokerId && isId(req.query.team) ? req.query.team : null;
    const status = kind === "developers" && C.STATUSES.includes(req.query.status) ? req.query.status : null;
    const scope = { brokerId, teamLeadId, from: range.from, to: range.to, page: Math.max(0, parseInt(req.query.page, 10) || 0), size: PAGE };
    const out = kind === "resale" ? await Deals.resaleCommissions(pool, actor, scope) : await Commissions.pageCommissions(pool, actor, { status, overdue: req.query.overdue === "1", ...scope });
    res.json({ kind, period: range.period, items: out.rows, total: out.total, totals: out.totals, statuses: C.STATUSES });
  });

  api.get("/commissions/:id", managers, async (req, res) => {
    const c = await Commissions.getCommission(pool, req.session.broker, req.params.id);
    return c ? res.json({ commission: c }) : res.status(404).json({ error: "not_found" });
  });

  api.post("/commissions/:id", managers, async (req, res) => {
    const out = await Commissions.move(pool, req.session.broker, req.params.id, String(req.body?.action || ""), req.body || {});
    return out.error ? fail(res, out) : res.json({ ok: true });
  });

  api.get("/sources", managers, async (req, res) => {
    const r = await Sources.report(pool, req.session.broker, { month: req.query.month });
    return r ? res.json(r) : res.status(403).json({ error: "forbidden" });
  });

  api.post("/sources/spend", managers, async (req, res) => {
    const r = await Sources.saveSpend(pool, req.session.broker, { month: req.body?.month, spend: req.body?.spend || {} });
    return r.error ? fail(res, r) : res.json({ ok: true });
  });

  api.get("/portal-enquiries", managers, async (req, res) => res.json({ items: await Enquiries.list(pool, req.session.broker) }));

  api.post("/portal-enquiries/:id/assign", managers, async (req, res) => {
    const r = await Enquiries.assign(pool, req.session.broker, req.params.id, { phone: req.body?.phone, brokerId: req.body?.brokerId });
    return r.error ? fail(res, r) : res.json({ ok: true, outcome: r.outcome });
  });

  api.post("/portal-enquiries/:id/link", managers, async (req, res) => {
    const r = await Enquiries.linkUnit(pool, req.session.broker, req.params.id, req.body?.unitCode);
    return r.error ? fail(res, r) : res.json({ ok: true });
  });

  api.get("/opened-links", async (req, res) => {
    const b = req.session.broker;
    const manager = Authz.isManager(b);
    const f = {
      q: String(req.query.q || "").slice(0, 60),
      status: OpenedLinks.STATUSES.includes(req.query.status) ? req.query.status : "all",
      channel: OpenedLinks.CHANNELS.includes(req.query.channel) ? req.query.channel : "all",
      source: OpenedLinks.SOURCES.includes(req.query.source) ? req.query.source : "all",
      broker: manager ? String(req.query.broker || "") : "",
      team: manager ? String(req.query.team || "") : "",
      page: req.query.page
    };
    res.json(await OpenedLinks.list(pool, b, f));
  });
}

module.exports = { register };
