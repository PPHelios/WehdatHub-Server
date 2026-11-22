// api/more.js — Projects catalogue, project library, compare, plan, usage and the platform pages for the app. Same services and
// role rules as the website (the services decide who may do what).
"use strict";

const Catalogue = require("../services/catalogue");
const Lib = require("../services/globalProjects");
const Compare = require("../lib/compareLinks");
const Billing = require("../services/billing");
const Credits = require("../services/credits");
const Referrals = require("../services/referrals");
const OwnerAgencies = require("../services/ownerAgencies");
const AgencyCreate = require("../services/agencyCreate");
const Signup = require("../services/signup");
const Dash = require("../services/dashboards");
const Period = require("../lib/period");
const { isManager, isAgencyOwner } = require("../lib/authz");
const Gallery = require("../services/projectGallery");
const G = require("../domain/gallery");
const Storage = require("../lib/supabase");
const RateLimit = require("../lib/rateLimit");
const { uploads } = require("../web/uploads");

// A project's photos: up to ${G.MAX_FILES} at a time. New-project photos are images only; the gallery upload also takes a PDF (sorted by AI).
const PHOTOS = { name: "doc", maxCount: G.MAX_FILES, accept: /^image\/(jpeg|png|webp)$/ };
const GALLERY_DOC = { name: "doc", maxCount: G.MAX_FILES, accept: /^(application\/pdf|image\/(jpeg|png|webp))$/ };
const uploadPhotos = uploads([PHOTOS], { maxMb: 25 });
const uploadGallery = uploads([GALLERY_DOC], { maxMb: 25 });

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
    // The same filters as the website's catalogue search: place (an area or sub-area id), features, developer, bedrooms, price up to.
    const features = [].concat(req.query.f || []);
    const [projects, developers] = await Promise.all([
      Catalogue.listProjectsPage(pool, actor, { q: req.query.q, page: req.query.page, archived, place: req.query.pl, features, developer: req.query.dev, bedrooms: req.query.bed, maxPrice: req.query.max }),
      Catalogue.listDevelopersPage(pool, actor, { q: req.query.dq, page: req.query.dp })
    ]);
    res.json({ projects, developers, canEdit: isManager(actor) });
  });

  // The search box (places, features, developers, projects), the developer list of the project form, and the message reader: the website's twins.
  const ProjectPaste = require("../services/projectPaste");
  const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
  api.get("/catalogue/search-box", async (req, res) => res.json({ items: await ProjectPaste.searchBox(pool, req.session.broker, req.query.q, langOf(req)) }));
  api.get("/catalogue/developers/suggest", managers, async (req, res) => res.json({ items: await ProjectPaste.developerBox(pool, req.session.broker, req.query.q) }));
  api.post("/catalogue/projects/read", managers, async (req, res) => res.json(await ProjectPaste.read(pool, req.session.broker, String((req.body || {}).text || ""), langOf(req))));

  api.get("/catalogue/projects/:id", async (req, res) => {
    const actor = req.session.broker;
    const data = UUID.test(req.params.id) ? await Catalogue.getProject(pool, actor, req.params.id) : null;
    if (!data) return res.status(404).json({ error: "not_found" });
    // The project's photos: shared first, then layouts (hidden ones only for managers); the first shared photo is the cover.
    const gal = await Gallery.list(pool, actor, req.params.id);
    const order = { shared: 0, layout: 1, hidden: 2 };
    const images = (gal ? gal.images : [])
      .filter((i) => isManager(actor) || i.role !== "hidden")
      .sort((a, b) => order[a.role] - order[b.role] || a.position - b.position)
      .map((i) => ({ id: i.id, url: Storage.photoUrl(i.url), role: i.role, kind: i.kind, mime: i.mime, match_status: i.match_status || null, listing_ids: i.listing_ids || [] }));
    const cover = images.find((i) => i.role === "shared" && String(i.mime).startsWith("image/"));
    return res.json({ ...data, images, cover_url: cover ? cover.url : null, canEdit: isManager(actor) });
  });

  // Photos of a new or existing project (the website's upload twin): images only, up to 10, no AI: every photo is shared with all units.
  // The AI sort is the separate, explicit gallery call below.
  const uploadGate = (req, res) => RateLimit.apiGate(pool, res, `upload:broker:${req.session.broker.id}`, RateLimit.LIMITS.uploadBroker);
  const galleryAnswer = (res, r) => {
    if (r.error === "forbidden") return res.status(403).json({ error: "forbidden" });
    if (r.error === "not_found") return res.status(404).json({ error: "not_found" });
    if (r.error) return res.status(r.error === "ALLOWANCE" ? 402 : 422).json({ error: r.error, left: r.left, needed: r.needed });
    return res.json(r);
  };
  api.post("/catalogue/projects/:id/photos", managers, uploadPhotos, async (req, res) => {
    if (!(await uploadGate(req, res))) return;
    return galleryAnswer(res, await Gallery.upload(pool, req.session.broker, req.params.id, { files: (req.files && req.files.doc) || [], sort: false }));
  });
  // "Sort with AI" (explicit, uses pages from the month's allowance; sort=1 is required for a PDF). Answers carry { error: ALLOWANCE, left, needed } like the website.
  api.post("/catalogue/projects/:id/gallery", managers, uploadGallery, async (req, res) => {
    if (!(await uploadGate(req, res))) return;
    const body = req.body || {};
    return galleryAnswer(res, await Gallery.upload(pool, req.session.broker, req.params.id, { files: (req.files && req.files.doc) || [], pages: body.pages, sort: body.sort === "1" || body.sort === "true" }));
  });
  api.post("/catalogue/projects/:id/gallery/:imageId", managers, async (req, res) => {
    const b = req.body || {};
    return galleryAnswer(res, await Gallery.update(pool, req.session.broker, req.params.id, req.params.imageId, { role: b.role, listingIds: Array.isArray(b.units) ? b.units : b.units_sent ? [].concat(b.unit || []) : undefined }));
  });
  api.post("/catalogue/projects/:id/gallery/:imageId/delete", managers, async (req, res) => galleryAnswer(res, await Gallery.remove(pool, req.session.broker, req.params.id, req.params.imageId)));

  api.post("/catalogue/projects/:id/archive", managers, async (req, res) => {
    const r = await Catalogue.archiveProject(pool, req.session.broker, req.params.id, req.body?.archived === true || req.body?.archived === "1");
    return r?.error ? fail(res, r) : res.json({ ok: true });
  });

  api.post("/catalogue/projects/:id/clarify", managers, async (req, res) => {
    const r = await Catalogue.addClarification(pool, req.session.broker, req.params.id, req.body || {});
    return r?.error ? fail(res, r) : res.json({ ok: true });
  });

  // Catalogue editing (managers): the same services as the website's forms. Files (project image, price list) stay on the website.
  const ok = (res, r) => (r?.error ? fail(res, r) : res.json({ ok: true, id: r?.id || r?.project?.id || r?.developer?.id || null }));
  api.post("/catalogue/developers", managers, async (req, res) => ok(res, await Catalogue.saveDeveloper(pool, req.session.broker, req.body || {})));
  api.post("/catalogue/developers/:id", managers, async (req, res) => ok(res, await Catalogue.saveDeveloper(pool, req.session.broker, { ...(req.body || {}), id: req.params.id })));
  api.post("/catalogue/projects", managers, async (req, res) => ok(res, await Catalogue.saveProject(pool, req.session.broker, req.body || {})));
  api.post("/catalogue/projects/:id", managers, async (req, res) => ok(res, await Catalogue.saveProject(pool, req.session.broker, { ...(req.body || {}), id: req.params.id })));
  api.post("/catalogue/projects/:id/phases", managers, async (req, res) => ok(res, await Catalogue.savePhase(pool, req.session.broker, req.params.id, req.body || {})));
  api.post("/catalogue/projects/:id/phases/:phaseId/delete", managers, async (req, res) => ok(res, await Catalogue.deletePhase(pool, req.session.broker, req.params.id, req.params.phaseId)));
  api.post("/catalogue/projects/:id/plans", managers, async (req, res) => ok(res, await Catalogue.savePlan(pool, req.session.broker, req.params.id, req.body || {})));
  api.post("/catalogue/projects/:id/plans/:planId/delete", managers, async (req, res) => ok(res, await Catalogue.deletePlan(pool, req.session.broker, req.params.id, req.params.planId)));

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
    const out = await Compare.createCompareLink(pool, req.session.broker, codes, { lang: req.body?.lang === "en" ? "en" : "ar", planState: req.planState });
    return out.error ? res.status(out.error === "count" ? 400 : 422).json({ error: out.error, missing: out.missing || [] }) : res.json(out);
  });

  // Plan and usage
  api.get("/plan", async (req, res) => {
    const b = req.session.broker;
    if (!isManager(b)) return res.status(403).json({ error: "forbidden" }); // the plan and its payments are for managers and the agency owner
    const [allowance, payTo, limits, agency] = await Promise.all([Billing.allowance(pool, b.agency_id), Billing.payTo(pool), Billing.planLimits(pool), Billing.agencyRow(pool, b.agency_id)]);
    const manager = isManager(b);
    const [payments, requests, referral] = manager ? await Promise.all([Billing.paymentsOf(pool, b.agency_id), Credits.requestsOf(pool, b.agency_id), Referrals.summary(pool, b.agency_id)]) : [[], [], null];
    const isOwner = isAgencyOwner(b);
    const Plans = require("../domain/plans");
    const canPay = isOwner || Boolean(agency?.manager_can_renew_plan);
    const canBuyCredits = isOwner || Boolean(agency?.manager_can_buy_credits);
    const running = allowance.source === "paid";
    const currentTier = Plans.tierOf(allowance.plan.id);
    const upgrades = Billing.upgradeQuotes(agency);
    const paymentChoices = [];
    if (canPay) for (const plan of Plans.PLANS) {
      const tier = Plans.tierOf(plan.id);
      if (running && currentTier >= 0 && tier !== currentTier) {
        if (upgrades[plan.id]) paymentChoices.push({ kind: "upgrade", plan: plan.id, name: plan.name, amount: upgrades[plan.id].amount });
        continue;
      }
      for (const months of Plans.periodsOf(plan)) {
        if (running && agency.last_months && months !== Number(agency.last_months)) continue;
        paymentChoices.push({ kind: "plan", plan: plan.id, months, name: plan.name, amount: Billing.priceAt(agency, plan.id, months)?.amount ?? Plans.priceFor(plan, months) });
      }
    }
    if (canBuyCredits && !allowance.ladder) for (const bundle of Plans.BUNDLES) {
      paymentChoices.push({ kind: "credit_bundle", bundle: bundle.id, name: bundle.name, amount: bundle.priceEgp });
    }
    res.json({
      allowance: Billing.publicAllowance(allowance),
      payTo,
      limits,
      payments: payments.map(Billing.publicPayment),
      requests,
      referral,
      canPay,
      canBuyCredits,
      paymentChoices,
      managerCanRenewPlan: Boolean(agency?.manager_can_renew_plan),
      managerCanBuyCredits: Boolean(agency?.manager_can_buy_credits)
    });
  });

  api.post("/plan/credit-request", agencyOwner, async (req, res) => {
    const r = await Credits.requestMore(pool, req.session.broker, { credits: req.body?.credits, note: req.body?.note });
    return r.error ? fail(res, r) : res.json({ ok: true });
  });

  api.post("/plan/pay", async (req, res) => {
    const b = req.session.broker;
    if (!isManager(b)) return res.status(403).json({ error: "forbidden" });
    const r = await Billing.requestPayment(pool, b, { kind: req.body?.kind, plan: req.body?.plan, months: req.body?.months, bundle: req.body?.bundle });
    if (r.error) {
      const status = r.error === "forbidden" || r.error === "owner_only" ? 403 : 400;
      return fail(res, r, status);
    }
    const BillingNotices = require("../services/billingNotices");
    BillingNotices.paymentRequested(r.payment, r.agency, b, pool);
    return res.json({ ok: true, payment: Billing.publicPayment(r.payment) });
  });

  api.post("/agency/billing-permissions", agencyOwner, async (req, res) => {
    const r = await Billing.updateBillingPermissions(pool, req.session.broker, req.session.broker.agency_id, {
      managerCanRenewPlan: req.body?.managerCanRenewPlan,
      managerCanBuyCredits: req.body?.managerCanBuyCredits
    });
    return r.error ? fail(res, r) : res.json(r);
  });

  api.get("/usage", async (req, res) => {
    const b = req.session.broker;
    const [allowance, ai] = await Promise.all([Billing.allowance(pool, b.agency_id), require("../services/aiUserLimits").overview(pool, b)]);
    res.json({ allowance: Billing.publicAllowance(allowance), ai });
  });

  // Platform (the app owner's pages)
  api.get("/platform", platform, async (req, res) => {
    const b = req.session.broker;
    const per = Period.parse(req.query.period);
    const [dashboard, period, agencies, signupOpen, pendingPayments] = await Promise.all([
      Dash.ownerDashboard(pool, b),
      Dash.ownerPeriod(pool, b, per),
      OwnerAgencies.list(pool),
      Signup.isOpen(pool),
      Billing.pendingPayments(pool)
    ]);
    res.json({ dashboard, period, agencies, signupOpen, pendingPayments, paymentChannels: await Billing.paymentChannels(pool) });
  });

  api.post("/platform/payment-channels", platform, async (req, res) => {
    const { sms, telegram } = req.body || {};
    if (typeof sms !== "boolean" || typeof telegram !== "boolean") return res.status(422).json({ error: "invalid_channels" });
    await Billing.setSetting(pool, "payment_channels", { sms, telegram });
    return res.json({ ok: true });
  });

  api.post("/platform/payments/:id/confirm", platform, async (req, res) => {
    const r = await Billing.confirmPayment(pool, req.params.id);
    if (r.error) return fail(res, r, r.error === "upgrade_stale" || r.error === "not_allowed" ? 409 : 400);
    const BillingNotices = require("../services/billingNotices");
    await BillingNotices.paymentConfirmed(pool, r).catch((e) => console.warn("Payment notice failed:", e.message));
    return res.json({ ok: true, payment: Billing.publicPayment(r.payment) });
  });

  api.post("/platform/payments/:id/cancel", platform, async (req, res) => {
    const r = await Billing.cancelPayment(pool, req.params.id);
    if (r.error) return fail(res, r, 400);
    return res.json({ ok: true, payment: Billing.publicPayment(r.payment) });
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
