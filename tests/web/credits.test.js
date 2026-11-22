// tests/web/credits.test.js — 053 AI credit pool: plans, bundles and credits per action come from the database.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const Credits = require("../../services/credits");
const Plans = require("../../domain/plans");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await closeHarness(h);
});

describe("AI credit pool (053)", () => {
  test("seeds the 2026 plan table (migration 126)", async () => {
    const plans = await Credits.plans(h.pool);
    const byId = Object.fromEntries(plans.map((p) => [p.id, p]));
    expect(byId.solo).toMatchObject({ price_egp: 199, seats: 1, units: 1000, credits: 400 });
    expect(byId.team).toMatchObject({ price_egp: 599, seats: 5, units: 5000, credits: 2000 });
    expect(byId.office).toMatchObject({ price_egp: 1790, seats: 15, units: 1000000, credits: 6000 });
    expect(byId.agency).toMatchObject({ price_egp: 2990, seats: 25, units: 1000000, credits: 10000 });
    expect(byId.enterprise).toMatchObject({ seats: 50, credits: 20000, active: false });
    expect(byId.free).toMatchObject({ price_egp: 0, units: 50, credits: 80 });
  });

  test("the explicit price table per plan and period, and the trial row (migration 128)", async () => {
    const byId = Object.fromEntries((await Credits.plans(h.pool)).map((p) => [p.id, p]));
    expect(byId.solo.prices).toEqual({ 1: 199, 6: 1075, 12: 1990 });
    expect(byId.team.prices).toEqual({ 1: 599, 6: 3235, 12: 5990 });
    expect(byId.office.prices).toEqual({ 1: 1790, 6: 9666, 12: 17900 });
    expect(byId.agency.prices).toEqual({ 6: 16146, 12: 29900 });
    expect(byId.enterprise.prices).toEqual({ 6: 29900, 12: 53900 });
    expect(byId.trial).toMatchObject({ price_egp: 0, seats: 1, units: 50, credits: 80, active: false, prices: {} });
    // Hydrated into domain/plans.js: the seed copy and the database agree; trial and enterprise are not sold.
    await Credits.refresh(h.pool);
    for (const id of ["solo", "team", "office", "agency"]) expect(Plans.planById(id).prices).toEqual(byId[id].prices);
    expect(Plans.PLANS.map((p) => p.id)).toEqual(["solo", "team", "office", "agency"]);
    expect(Plans.planById("trial")).toMatchObject({ seats: 1, units: 50, credits: 80 });
    expect(Plans.planById("enterprise")).toBeNull();
    expect(Plans.periodsOf(Plans.planById("agency"))).toEqual([6, 12]);
  });

  test("seeds the four extra bundles (migration 128)", async () => {
    const list = (await Credits.bundles(h.pool)).map((b) => [b.credits, b.price_egp]);
    expect(list).toEqual([
      [200, 99],
      [500, 229],
      [1000, 399],
      [2500, 899]
    ]);
    expect((await Credits.bundles(h.pool)).find((b) => b.credits === 2500)).toMatchObject({ id: "agency", name_en: "Agency Pack", name_ar: "باقة الشركات" });
    expect(Plans.BUNDLES.map((b) => [b.credits, b.priceEgp])).toEqual([[200, 99], [500, 229], [1000, 399], [2500, 899]]);
  });

  test("prices each action in credits and reads 0 for an unknown action", async () => {
    expect(await Credits.creditsFor(h.pool, "text")).toBe(1);
    expect(await Credits.creditsFor(h.pool, "voice")).toBe(3);
    expect(await Credits.creditsFor(h.pool, "page")).toBe(10);
    expect(await Credits.creditsFor(h.pool, "search_grounded")).toBe(0);
  });

  test("a slow request-driven refresh stays single even past the TTL", async () => {
    await Credits.refresh(h.pool);
    const now = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 61000);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const db = { query: jest.fn(async (...args) => {
      await gate;
      return h.pool.query(...args);
    }) };
    const first = Credits.ensureFresh(db);
    try {
      const reads = db.query.mock.calls.length;
      await Promise.resolve();
      const started = db.query.mock.calls.length - reads;
      expect(started).toBeGreaterThan(0);

      now.mockReturnValue(Date.now() + 61000);
      void Credits.ensureFresh(db);
      await Promise.resolve();
      expect(db.query).toHaveBeenCalledTimes(started);
    } finally {
      now.mockRestore();
      release();
      await first;
    }
  });

  test("the planning rate defaults to 60 EGP per dollar and follows the app setting", async () => {
    expect(await Credits.planningRate(h.pool)).toBe(60);
    await h.pool.query("INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [Credits.FX_KEY, JSON.stringify(62)]);
    expect(await Credits.planningRate(h.pool)).toBe(62);
  });
});

describe("owner page: plans and credits", () => {
  const { signIn } = require("../harness/web");
  const owner = async () => {
    process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
    require("../../config").resetConfig();
    return signIn(h, "admin");
  };
  afterEach(() => {
    delete process.env.OWNER_BROKER_IDS;
    require("../../config").resetConfig();
  });

  test("edits plans, adds a plan and a bundle, prices actions; the plan page follows", async () => {
    const { agent, csrf } = await owner();
    const page = await agent.get("/app/owner");
    expect(page.text).toContain("data-credit-plans");
    expect(page.text).toContain("data-credit-bundles");
    expect(page.text).toContain("data-credit-actions");

    const form = { _csrf: csrf, new_id: "boutique", new_name_ar: "فريق", new_name_en: "Team", new_price: "1200", new_seats: "8", new_units: "900", new_credits: "3200" };
    for (const p of await Credits.plans(h.pool)) Object.assign(form, { [`p_${p.id}_name_ar`]: p.name_ar, [`p_${p.id}_name_en`]: p.name_en, [`p_${p.id}_price`]: p.id === "solo" ? 249 : p.price_egp, [`p_${p.id}_seats`]: p.seats, [`p_${p.id}_units`]: p.units, [`p_${p.id}_credits`]: p.credits, [`p_${p.id}_active`]: "on" });
    expect((await agent.post("/app/owner/credit-plans").type("form").send(form)).status).toBe(200);
    const byId = Object.fromEntries((await Credits.plans(h.pool)).map((p) => [p.id, p]));
    expect(byId.solo.price_egp).toBe(249);
    expect(byId.boutique).toMatchObject({ price_egp: 1200, seats: 8, credits: 3200 });
    expect(require("../../domain/plans").planById("boutique")).toBeTruthy();
    // A later validation error rolls back an earlier plan change.
    const bad = await agent.post("/app/owner/credit-plans").type("form").send({ ...form, p_solo_price: "299" });
    expect(bad.status).toBe(400);
    expect((await Credits.plans(h.pool)).find((p) => p.id === "solo").price_egp).toBe(249);

    const bundles = { _csrf: csrf, new_bundle_id: "b2000", new_bundle_name_ar: "٢٠٠٠", new_bundle_name_en: "2,000", new_bundle_price: "650", new_bundle_credits: "2000" };
    for (const b of await Credits.bundles(h.pool)) Object.assign(bundles, { [`b_${b.id}_name_ar`]: b.name_ar, [`b_${b.id}_name_en`]: b.name_en, [`b_${b.id}_price`]: b.price_egp, [`b_${b.id}_credits`]: b.credits, [`b_${b.id}_active`]: "on" });
    expect((await agent.post("/app/owner/credit-bundles").type("form").send(bundles)).status).toBe(200);
    expect((await Credits.bundles(h.pool)).map((b) => b.credits)).toContain(2000);
    const beforeBundles = await Credits.bundles(h.pool);
    expect(await Credits.saveBundles(h.pool, { ...bundles, b_small_price: 101 })).toMatchObject({ error: "bundle" });
    expect(await Credits.bundles(h.pool)).toEqual(beforeBundles);

    const acts = { _csrf: csrf, fx: "55", cost_usd: "0.003" };
    for (const a of await Credits.actions(h.pool)) acts[`a_${a.action}`] = a.action === "flyer" ? 5 : a.credits;
    expect((await agent.post("/app/owner/credit-actions").type("form").send(acts)).status).toBe(200);
    expect(await Credits.creditsFor(h.pool, "flyer")).toBe(5);
    expect(await Credits.planningRate(h.pool)).toBe(55);
    expect(await Credits.saveActionsAndRates(h.pool, { ...acts, a_flyer: 8, fx: "0" })).toEqual({ error: "rates" });
    expect(await Credits.creditsFor(h.pool, "flyer")).toBe(5);
  });

  test("a manager's request reaches the owner page; approving grants the credits; owner can grant directly", async () => {
    const { agent, csrf } = await owner();
    const admin = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];
    expect((await Credits.requestMore(h.pool, { ...admin, role: "owner" }, { credits: 300, note: "busy month" })).ok).toBe(true);
    const page = await agent.get("/app/owner");
    expect(page.text).toContain("data-credit-request=");
    const [req] = await Credits.pendingRequests(h.pool);
    const before = (await Credits.poolFor(h.pool, admin.agency_id, "free")).total;
    const when = new Date();
    jest.spyOn(when, "toISOString").mockReturnValue("invalid timestamp");
    await expect(Credits.decideRequest(h.pool, req.id, { approve: true, now: when })).rejects.toThrow(/timestamp/);
    expect((await Credits.poolFor(h.pool, admin.agency_id, "free")).total).toBe(before);
    expect((await agent.post(`/app/owner/credit-requests/${req.id}`).type("form").send({ _csrf: csrf, decision: "approve", credits: "250" })).status).toBe(200);
    expect((await Credits.poolFor(h.pool, admin.agency_id, "free")).total).toBe(before + 250);
    expect(await Credits.pendingRequests(h.pool)).toEqual([]);
    expect(await Credits.decideRequest(h.pool, req.id, { approve: true })).toEqual({ error: "not_pending" });
    expect((await agent.post("/app/owner/credit-grant").type("form").send({ _csrf: csrf, agency: admin.agency_id, credits: "100", note: "gift" })).status).toBe(200);
    expect((await Credits.poolFor(h.pool, admin.agency_id, "free")).total).toBe(before + 350);
    expect((await agent.post("/app/owner/credit-grant").type("form").send({ _csrf: csrf, agency: admin.agency_id, credits: "0" })).status).toBe(400);
  });
});

describe("bundle validity and big reads", () => {
  test("a bundle lasts 30 days: bought late in a month it carries into the next, less what was used above the plan", async () => {
    const agency = h.AGENCY_A;
    await h.query("UPDATE agencies SET pilot = false, plan = 'solo', paid_until = '2027-12-31' WHERE id = $1", [agency]);
    const at = new Date("2026-10-26T10:00:00Z");
    await h.query("INSERT INTO payments (agency_id, kind, plan, months, amount_egp, reference, status, bundle_id, confirmed_at) VALUES ($1, 'credit_bundle', NULL, 1, 399, 'WH-T1', 'confirmed', 'large', $2)", [agency, at.toISOString()]);
    const bundleCredits = (await Credits.bundles(h.pool)).find((b) => b.id === "large").credits;
    // 100 text requests above the plan's 400 in the purchase month.
    for (let i = 0; i < 500; i++) await h.query("INSERT INTO operation_logs (agency_id, operation_type, status, model_used, created_at) VALUES ($1, 'listing_extraction', 'success', 'm', $2)", [agency, new Date("2026-10-27T10:00:00Z").toISOString()]);
    const nov = await Credits.poolFor(h.pool, agency, "solo", { now: new Date("2026-11-05T10:00:00Z") });
    expect(nov).toMatchObject({ plan: 400, bundles: bundleCredits - 100 });
    const dec = await Credits.poolFor(h.pool, agency, "solo", { now: new Date("2026-11-30T10:00:00Z") });
    expect(dec.bundles).toBe(0);
  });
});
