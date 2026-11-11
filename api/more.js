// api/more.js — Projects catalogue, project library, compare, plan, usage and the platform pages for the app. Same services and
// role rules as the website (the services decide who may do what).
"use strict";

const Catalogue = require("../services/catalogue");
const Lib = require("../services/globalProjects");
const Compare = require("../lib/compareLinks");
const Billing = require("../services/billing");
const Credits = require("../services/credits");
const UsageCredits = require("../lib/credits");
const Referrals = require("../services/referrals");
const OwnerAgencies = require("../services/ownerAgencies");
const AgencyCreate = require("../services/agencyCreate");
const Signup = require("../services/signup");
const Dash = require("../services/dashboards");
const Period = require("../lib/period");
const { isManager, isAgencyOwner } = require("../lib/authz");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = { forbidden: 403, not_found: 404, duplicate: 409 };
const fail = (res, r) => res.status(CODE[r.error] || 422).json({ error: r.error || "failed" });

function register(api, { pool }) {
  const managers = (req, res, next) => (isManager(req.session.broker) ? next() : res.status(403).json({ error: "forbidden" }));
  const agencyOwner = (req, res, next) => (isAgencyOwner(req.session.broker) ? next() : res.status(403).json({ error: "forbidden" }));
  const platform = (req, res, next) => (Dash.isOwner(req.session.broker) ? next() : res.status(404).json({ error: "not_found" }));

  // Projects
  api.get("/catalogue", async (req, res) => {
    const actor = req.session.broker;
    const archived = req.query.archived === "1";
    const [projects, developers] = await Promise.all([Catalogue.listProjectsPage(pool, actor, { q: req.query.q, page: req.query.page, archived }), Catalogue.listDevelopersPage(pool, actor, { q: req.query.dq, page: req.query.dp })]);
    res.json({ projects, developers, canEdit: isManager(actor) });
  });

  api.get("/catalogue/projects/:id", async (req, res) => {
    const data = UUID.test(req.params.id) ? await Catalogue.getProject(pool, req.session.broker, req.params.id) : null;
    return data ? res.json({ ...data, canEdit: isManager(req.session.broker) }) : res.status(404).json({ error: "not_found" });
  });

  api.post("/catalogue/projects/:id/archive", managers, async (req, res) => {
    const r = await Catalogue.archiveProject(pool, req.session.broker, req.params.id, req.body?.archived === true || req.body?.archived === "1");
    return r?.error ? fail(res, r) : res.json({ ok: true });
  });

  api.post("/catalogue/projects/:id/clarify", managers, async (req, res) => {
    const r = await Catalogue.addClarification(pool, req.session.broker, req.params.id, req.body || {});
    return r?.error ? fail(res, r) : res.json({ ok: true });
  });

  // Library
  api.get("/library", managers, async (req, res) => {
    const out = await Lib.listPage(pool, { agencyId: req.session.broker.agency_id, q: String(req.query.q || "").slice(0, 60), page: req.query.page });
    res.json(out);
  });

  api.post("/library/:id/use", managers, async (req, res) => {
    const r = await Lib.use(pool, req.session.broker, req.params.id);
    return r.ok ? res.json({ ok: true, projectId: r.project.id }) : fail(res, r);
  });

  // Compare units for a client (a link to share)
  api.post("/compare", async (req, res) => {
    const codes = Compare.parseCodes(req.body?.codes || []);
    const out = await Compare.createCompareLink(pool, req.session.broker, codes, { lang: req.body?.lang === "en" ? "en" : "ar" });
    return out.error ? res.status(out.error === "count" ? 400 : 422).json({ error: out.error, missing: out.missing || [] }) : res.json(out);
  });

  // Plan and usage
  api.get("/plan", async (req, res) => {
    const b = req.session.broker;
    const [allowance, payTo, limits] = await Promise.all([Billing.allowance(pool, b.agency_id), Billing.payTo(pool), Billing.planLimits(pool)]);
    const manager = isManager(b);
    const [payments, requests, referral] = manager ? await Promise.all([Billing.paymentsOf(pool, b.agency_id), Credits.requestsOf(pool, b.agency_id), Referrals.summary(pool, b.agency_id)]) : [[], [], null];
    res.json({ allowance, payTo, limits, payments, requests, referral, canPay: isAgencyOwner(b) });
  });

  api.post("/plan/credit-request", agencyOwner, async (req, res) => {
    const r = await Credits.requestMore(pool, req.session.broker, { credits: req.body?.credits, note: req.body?.note });
    return r.error ? fail(res, r) : res.json({ ok: true });
  });

  api.post("/plan/pay", agencyOwner, async (req, res) => {
    const r = await Billing.requestPayment(pool, req.session.broker, { kind: req.body?.kind, plan: req.body?.plan, months: req.body?.months, bundle: req.body?.bundle });
    return r.error ? fail(res, r) : res.json({ ok: true, payment: r.payment });
  });

  api.get("/usage", async (req, res) => {
    const b = req.session.broker;
    const [state, allowance] = await Promise.all([UsageCredits.check(pool, b), Billing.allowance(pool, b.agency_id)]);
    const mine = await UsageCredits.usage(pool, b.agency_id, { brokerId: b.id });
    const agency = isManager(b) ? await UsageCredits.usage(pool, b.agency_id) : null;
    res.json({ state, allowance, mine, agency });
  });

  // Platform (the app owner's pages)
  api.get("/platform", platform, async (req, res) => {
    const b = req.session.broker;
    const per = Period.parse(req.query.period);
    const [dashboard, period, agencies, signupOpen] = await Promise.all([Dash.ownerDashboard(pool, b), Dash.ownerPeriod(pool, b, per), OwnerAgencies.list(pool), Signup.isOpen(pool)]);
    res.json({ dashboard, period, agencies, signupOpen });
  });

  api.get("/platform/agencies/:id", platform, async (req, res) => {
    const a = UUID.test(req.params.id) ? await OwnerAgencies.get(pool, req.params.id) : null;
    return a ? res.json({ agency: a }) : res.status(404).json({ error: "not_found" });
  });

  api.post("/platform/agencies/:id/plan", platform, async (req, res) => {
    if (!UUID.test(req.params.id)) return fail(res, { error: "not_found" });
    const r = await OwnerAgencies.setPlan(pool, req.session.broker, req.params.id, { plan: req.body?.plan, until: req.body?.until || null, months: req.body?.until ? null : req.body?.months ?? null, pilot: req.body?.pilot === true || req.body?.pilot === "1" });
    return r.error ? fail(res, r) : res.json({ ok: true });
  });

  api.post("/platform/agencies/:id/suspend", platform, async (req, res) => {
    if (!UUID.test(req.params.id)) return fail(res, { error: "not_found" });
    const r = await OwnerAgencies.suspend(pool, req.session.broker, req.params.id);
    return r.error ? fail(res, r) : res.json({ ok: Boolean(r.ok), brokers: r.brokers });
  });

  api.post("/platform/agencies/:id/resume", platform, async (req, res) => {
    if (!UUID.test(req.params.id)) return fail(res, { error: "not_found" });
    const r = await OwnerAgencies.resume(pool, req.session.broker, req.params.id);
    return r.error ? fail(res, r) : res.json({ ok: Boolean(r.ok), brokers: r.brokers });
  });

  api.post("/platform/announce", platform, async (req, res) => {
    const r = await OwnerAgencies.announce(pool, req.session.broker, { title: req.body?.title, body: req.body?.body });
    return r.ok ? res.json({ ok: true, sent: r.sent }) : fail(res, r);
  });

  api.post("/platform/signup", platform, async (req, res) => {
    await Signup.setOpen(pool, req.body?.open === true || req.body?.open === "1");
    res.json({ ok: true });
  });

  api.post("/platform/agencies", platform, async (req, res) => {
    const r = await AgencyCreate.createAgency(pool, req.session.broker, { agency: req.body?.agency, logo: req.body?.logo, ownerName: req.body?.ownerName, ownerPhone: req.body?.ownerPhone, plan: req.body?.plan });
    return r.error ? fail(res, r) : res.json({ ok: true, agency: { id: r.agency.id, name: r.agency.name }, url: r.url || null });
  });
}

module.exports = { register };
