// api/deals.js — Deals, commissions, lead sources, portal enquiries and opened links for the app. Same services and rules as the website.
"use strict";

const Leases = require("../services/leases");
const { inputFromForm, correctionFrom } = require("../lib/dealForm");
const Deals = require("../services/deals");
const Commissions = require("../services/commissions");
const Sources = require("../services/leadSources");
const Enquiries = require("../services/portalEnquiries");
const PortalParse = require("../domain/portalEnquiry");
const Card = require("../domain/leadCard");
const Phone = require("../domain/phone");
const RateLimit = require("../lib/rateLimit");
const OpenedLinks = require("../services/openedLinks");
const C = require("../domain/commissionTracker");
const P = require("../domain/commissionPeriod");
const Authz = require("../lib/authz");
const Router = require("../domain/assistantRouter");
const { isId } = require("../lib/dealScope");

const PAGE = 20;
const CODE = { forbidden: 403, not_found: 404, conflict: 409, status_backwards: 403, confirm_reopen: 409 };
const fail = (res, r) => res.status(CODE[r.error] || 422).json({ error: r.error, ...(r.field ? { field: r.field } : {}) });

function register(api, { pool }) {
  const managers = (req, res, next) => (Authz.isManager(req.session.broker) ? next() : res.status(403).json({ error: "forbidden" }));

  api.get("/deals", async (req, res) => {
    const n = Math.max(0, parseInt(req.query.page, 10) || 0);
    const b = req.session.broker;
    const report = ["recent", "last"].includes(req.query.report) ? req.query.report : null;
    const week = /^[0-4]$/.test(String(req.query.week ?? "")) ? Number(req.query.week) : null;
    let from = null;
    let to = null;
    if (req.query.from || req.query.to) {
      const interval = Router.resolveInterval({ from: req.query.from, to: req.query.to });
      if (interval.error) return res.status(422).json({ error: interval.error });
      from = interval.from;
      to = interval.to;
    }
    const brokerId = Authz.isManager(b) && isId(req.query.broker) ? req.query.broker : null;
    const brokerRole = req.query.brokerRole === "participant" ? "participant" : "closer";
    const market = ["resale", "primary", "unknown"].includes(req.query.market) ? req.query.market : null;
    const area = typeof req.query.area === "string" && req.query.area.trim() ? req.query.area.trim().slice(0, 80) : null;
    const filterOpts = { status: req.query.status, from, to, brokerId, brokerRole, market, area };
    const wantSummary = req.query.summary === "1" || Boolean(from || brokerId || market || area);
    const [list, totals, dealSummary] = await Promise.all([
      Deals.listDeals(pool, b, { ...filterOpts, offset: n * PAGE, report, week }),
      report || (from && to) ? [] : Deals.monthlyTotals(pool, b),
      wantSummary ? Deals.dealsSummary(pool, b, filterOpts) : null
    ]);
    // `allowed`: the statuses this person may choose for each deal now (forward, or cancel before paid; managers may reopen with a confirmation).
    return res.json({ items: list.rows.map((r) => ({ ...r, allowed: Deals.allowedStatuses(b, r.status) })), more: list.more, totals, summary: list.summary, ...(dealSummary ? { dealSummary } : {}), statuses: Deals.STATUSES });
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
    const r = await Deals.updateDeal(pool, b, deal.id, { status: req.body?.status, confirmReopen: req.body?.confirm === true || req.body?.confirm === "1" }, { version: req.body?.version ?? deal.version });
    return r.ok || r.unchanged ? res.json({ ok: true }) : r.conflict ? res.status(409).json({ error: "conflict" }) : fail(res, r);
  });

  api.get("/commissions", async (req, res) => {
    const actor = req.session.broker;
    const manager = Authz.isManager(actor);
    const lead = Authz.isTeamLead(actor);
    const kind = req.query.kind === "developers" ? "developers" : "resale";
    const range = P.periodRange(req.query.period || (kind === "developers" ? "all" : undefined), req.query.at);
    const brokerId = (manager || lead) && isId(req.query.broker) ? req.query.broker : null;
    const teamLeadId = manager && !brokerId && isId(req.query.team) ? req.query.team : null;
    const status = kind === "developers" && C.STATUSES.includes(req.query.status) ? req.query.status : null;
    const developerId = kind === "developers" && isId(req.query.developer) ? req.query.developer : null;
    const scope = { brokerId, teamLeadId, from: range.from, to: range.to, page: Math.max(0, parseInt(req.query.page, 10) || 0), size: PAGE };
    const out = kind === "resale" ? await Deals.resaleCommissions(pool, actor, scope) : await Commissions.pageCommissions(pool, actor, { status, developerId, overdue: req.query.overdue === "1", ...scope });
    res.json({ kind, period: range.period, items: out.rows, total: out.total, totals: out.totals, byDeveloper: out.byDeveloper || [], statuses: C.STATUSES });
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
    const r = await Sources.report(pool, req.session.broker, { month: req.query.month, signedOnly: req.query.signed === "1" });
    return r ? res.json(r) : res.status(403).json({ error: "forbidden" });
  });

  api.post("/sources/spend", managers, async (req, res) => {
    const r = await Sources.saveSpend(pool, req.session.broker, { month: req.body?.month, spend: req.body?.spend || {} });
    return r.error ? fail(res, r) : res.json({ ok: true });
  });

  api.get("/portal-enquiries", managers, async (req, res) => res.json({ items: await Enquiries.list(pool, req.session.broker) }));

  // Reads a pasted portal message; nothing is saved. 422 when the text is not a portal enquiry.
  api.post("/portal-enquiries/read", managers, async (req, res) => {
    if (!(await RateLimit.apiGate(pool, res, `lead_extract:broker:${req.session.broker.id}`, RateLimit.LIMITS.extractBroker))) return undefined;
    const p = PortalParse.parse(String(req.body?.message || "").slice(0, 4000));
    if (!p) return res.status(422).json({ ok: false, error: "not_enquiry" });
    return res.json({ ok: true, portal: p.portal, name: p.name, link: p.link, listingNo: p.listingNo });
  });

  // Keeps a pasted portal enquiry (a repeat within a day is not kept twice); with phone + brokerId it also becomes a lead.
  api.post("/portal-enquiries", managers, async (req, res) => {
    const broker = req.session.broker;
    if (!(await RateLimit.apiGate(pool, res, `lead_extract:broker:${broker.id}`, RateLimit.LIMITS.extractBroker))) return undefined;
    const b = req.body || {};
    const message = String(b.message || "").slice(0, 4000);
    const phone = String(b.phone || "").trim();
    const brokerId = String(b.brokerId || "").trim();
    if (phone && !Phone.toE164(phone)) return res.status(422).json({ error: "phone_invalid" });
    if (!PortalParse.parse(message)) return res.status(422).json({ error: "not_enquiry" });
    const cap = await Enquiries.capture(pool, broker, message);
    if (cap.outcome === "forbidden") return res.status(403).json({ error: "forbidden" });
    const id = cap.outcome === "repeat" ? cap.id : cap.enquiry.id;
    const out = { id, deduped: cap.outcome === "repeat", assigned: false, leadRef: null };
    if (phone && brokerId) {
      const r = await Enquiries.assign(pool, broker, id, { phone, brokerId });
      if (r.error) return res.status(CODE[r.error] || 422).json({ ...out, error: r.error });
      Object.assign(out, { assigned: true, leadRef: Card.refLabel(r.leadRef), outcome: r.outcome });
    }
    return res.status(out.deduped ? 200 : 201).json(out);
  });

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
      days: req.query.days,
      page: req.query.page
    };
    if (req.query.leadRef !== undefined) {
      const lead = await require("../services/leads").getLead(pool, b, String(req.query.leadRef));
      if (!lead) return res.status(404).json({ error: "not_found" });
      f.leadId = lead.id;
      f.mine = true;
    }
    res.json(await OpenedLinks.list(pool, b, f));
  });
}

module.exports = { register };
