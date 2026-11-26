// tests/web/unit-cap.test.js — The plan's cap on units: available, archived and sold units count (deleted don't), a new unit past
// the cap isn't saved (web form, price-sheet apply, import) and the broker is told to upgrade; the owner edits the caps.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Credits = require("../../services/credits");
const Billing = require("../../services/billing");
const Store = require("../../lib/listingStore");
const Plans = require("../../domain/plans");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const setCap = async (plan, units) => {
  await h.query("UPDATE credit_plans SET units = $2 WHERE id = $1", [plan, units]);
  await Credits.refresh(h.pool);
};
const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const FIELDS = { listing_type: "sale", market: "resale", property_type: "apartment", compound: "Hyde Park", price_value: "9 مليون", area_value: "150", bedrooms: "3", bathrooms: "2", finishing: "fully_finished" };

test("defaults per plan, owner overrides, and what counts", async () => {
  expect(Plans.planById("free").units).toBe(50);
  expect(await Billing.planLimits(h.pool)).toEqual({ solo: 1000, team: 5000, office: 1000000, agency: 1000000, free: 50, trial: 50, trial_team: 50 });
  await setCap("office", 2);
  await h.insertListing({ code: "CAP-1" });
  await h.insertListing({ code: "CAP-2", status: "sold" });
  await h.insertListing({ code: "CAP-3", status: "archived" });
  const a = await Billing.allowance(h.pool, h.BROKERS.broker.agency_id);
  // Sold units count too: available + archived + sold = 3 (a deleted one would not).
  expect(a.units).toEqual({ used: 3, limit: 2 });
  expect((await Billing.unitCapacity(h.pool, h.BROKERS.broker.agency_id)).ok).toBe(false);
  await h.insertListing({ code: "CAP-4", status: "deleted" });
  expect((await Billing.allowance(h.pool, h.BROKERS.broker.agency_id)).units.used).toBe(3);
});

test("a unit past the cap is refused with the upgrade message; archiving does not make room, deleting does", async () => {
  await setCap("office", 1);
  await h.insertListing({ code: "CAP-1" });
  const { agent, csrf } = await signIn(h, "broker");
  const r = await agent.post("/app/units/new").field("_csrf", csrf).field("force", "1").field("listing_type", "sale").field("market", "resale").field("property_type", "apartment").field("compound", "Hyde Park").field("price_value", "9 مليون").field("area_value", "150").field("bedrooms", "3").field("bathrooms", "2").field("finishing", "fully_finished").field("owner_name", "Mr Owner").field("owner_phone", "01012345678");
  expect(r.status).toBe(403);
  expect(r.text).toContain("وصلت للحد الأقصى");
  expect((await h.query("SELECT count(*)::int AS n FROM listings WHERE agency_id = $1", [h.BROKERS.broker.agency_id]))[0].n).toBe(1);
  await h.query("UPDATE listings SET status = 'deleted', deleted_at = now() WHERE code = 'CAP-1'");
  const ok = await agent.post("/app/units/new").field("_csrf", csrf).field("force", "1").field("listing_type", "sale").field("market", "resale").field("property_type", "apartment").field("compound", "Hyde Park").field("price_value", "9 مليون").field("area_value", "150").field("bedrooms", "3").field("bathrooms", "2").field("finishing", "fully_finished").field("owner_name", "Mr Owner").field("owner_phone", "01012345678");
  expect(ok.status).toBe(303);
});

test("createListing reports the cap and plan; English text", async () => {
  await setCap("office", 1);
  await h.insertListing({ code: "CAP-1" });
  const res = await Store.createListing(h.pool, await row("broker"), { fields: { listing_type: "sale", property_type: "apartment", price_value: 5e6, area_value: 100, details: { owner_name: "Mr Owner", owner_phone: "01012345678" } }, code: null, lang: "en" });
  expect(res.limit).toMatchObject({ used: 1, limit: 1 });
  expect(Plans.unitLimitText(res.limit, "en")).toContain("Office plan holds 1 units");
});

test("owner edits the caps on /app/owner; the plan page shows the meter", async () => {
  process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
  require("../../config").resetConfig();
  try {
    const { agent, csrf } = await signIn(h, "admin");
    expect((await agent.get("/app/owner")).text).toContain("data-credit-plans");
    const form = { _csrf: csrf };
    for (const p of await Credits.plans(h.pool)) Object.assign(form, { [`p_${p.id}_name_ar`]: p.name_ar, [`p_${p.id}_name_en`]: p.name_en, [`p_${p.id}_price`]: p.price_egp, [`p_${p.id}_seats`]: p.seats, [`p_${p.id}_units`]: p.id === "solo" ? 200 : p.units, [`p_${p.id}_credits`]: p.credits, [`p_${p.id}_active`]: "on" });
    const r = await agent.post("/app/owner/credit-plans").type("form").send(form);
    expect(r.status).toBe(200);
    expect((await Billing.planLimits(h.pool)).solo).toBe(200);
    const plan = await agent.get("/app/usage?lang=en");
    expect(plan.text).toContain("Units (available, archived and sold)");
    const b = await signIn(h, "broker");
    expect((await b.agent.post("/app/owner/credit-plans").type("form").send({ _csrf: b.csrf })).status).toBe(404);
  } finally {
    delete process.env.OWNER_BROKER_IDS;
    require("../../config").resetConfig();
  }
});

test("the unit cap message names sold units in both languages", () => {
  const limit = { used: 50, limit: 50, plan: Plans.planById("free") };
  expect(Plans.unitLimitText(limit, "en")).toContain("(available, archived and sold)");
  expect(Plans.unitLimitText(limit, "ar")).toContain("المتاحة والمؤرشفة والمباعة");
});

describe("85% soft warning", () => {
  const BillingNotices = require("../../services/billingNotices");
  const fill = async (n) => {
    for (let i = 0; i < n; i++) await h.insertListing({ code: `W-${i}`, status: i % 3 === 0 ? "sold" : "active" });
  };

  test("unitLevel: 85 from 85% of the cap, 100 at the cap, never for an unlimited plan", () => {
    expect(Billing.unitLevel({ used: 83, limit: 100 })).toBeNull();
    expect(Billing.unitLevel({ used: 85, limit: 100 })).toBe(85);
    expect(Billing.unitLevel({ used: 99, limit: 100 })).toBe(85);
    expect(Billing.unitLevel({ used: 100, limit: 100 })).toBe(100);
    expect(Billing.unitLevel({ used: 999999, limit: Plans.UNLIMITED })).toBeNull();
  });

  test("the Plan page and the dashboard show a banner from 85%, none below it or on an unlimited plan", async () => {
    await setCap("office", 10);
    await fill(8);
    const { agent } = await signIn(h, "admin");
    expect((await agent.get("/app/usage?lang=en")).text).not.toContain("data-unit-warning");
    await h.insertListing({ code: "W-8" });
    const usage = await agent.get("/app/usage?lang=en");
    expect(usage.text).toContain('data-unit-warning="85"');
    expect(usage.text).toContain("Available, archived and sold units all count");
    expect((await agent.get("/app/dashboard?lang=en")).text).toContain('data-unit-warning="85"');
    await h.insertListing({ code: "W-9" });
    expect((await agent.get("/app/usage?lang=en")).text).toContain('data-unit-warning="100"');
    await setCap("office", Plans.UNLIMITED);
    expect((await agent.get("/app/usage?lang=en")).text).not.toContain("data-unit-warning");
    expect((await agent.get("/app/dashboard?lang=en")).text).not.toContain("data-unit-warning");
  });

  test("owner and managers are told once per level, then again at 100%", async () => {
    await h.seedBroker("owner");
    await setCap("office", 10);
    await fill(9);
    const agencyId = h.BROKERS.broker.agency_id;
    const first = await BillingNotices.warnUnits(h.pool);
    expect(first.sent).toBeGreaterThan(0);
    expect((await BillingNotices.warnUnits(h.pool)).sent).toBe(first.sent);
    const rows = async () => await h.query("SELECT broker_id, dedupe_key FROM notifications WHERE dedupe_key LIKE 'units_warn:%' AND agency_id = $1", [agencyId]);
    const at85 = await rows();
    expect(new Set(at85.map((r) => r.dedupe_key))).toEqual(new Set(["units_warn:office:85"]));
    expect(at85.map((r) => r.broker_id)).toContain(h.BROKERS.owner.id);
    expect(new Set(at85.map((r) => r.broker_id)).size).toBe(at85.length);
    await h.insertListing({ code: "W-X" });
    await BillingNotices.warnUnits(h.pool);
    expect(new Set((await rows()).map((r) => r.dedupe_key))).toEqual(new Set(["units_warn:office:85", "units_warn:office:100"]));
  });

  test("no notification for an unlimited plan", async () => {
    await fill(3);
    await BillingNotices.warnUnits(h.pool);
    expect(await h.query("SELECT 1 FROM notifications WHERE dedupe_key LIKE 'units_warn:%'")).toEqual([]);
  });
});
