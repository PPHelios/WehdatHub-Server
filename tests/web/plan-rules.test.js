// tests/web/plan-rules.test.js — Phase 4 of the new pricing: mid-cycle upgrades, no downgrade / no length switch, the price lock
// with Founding Partner, and the hidden extra-seats override.
//  5. Upgrade: a pro-rated `upgrade` payment (new per month - current per month) x remaining days / 30, whole EGP; confirming changes the plan, not paid_until.
//  6. While paid_until is in the future only the same plan for the same length (renewal, queued) or a higher plan: downgrade / period_switch / upgrade_required.
//  7. A confirmed 12-month payment snapshots the prices (locked_prices until lock_until); requestPayment uses them; Founding Partner: first 12-month lock lasts 24 months, max 20.
//  8. Extra seats (platform owner only): 180 EGP a seat a month up front, +400 credits each, 0..4, reset on a new paid period after expiry.
// Everything takes an injected `now`; the page tests use the real clock.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const crypto = require("crypto");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const { resetConfig } = require("../../config");
const Billing = require("../../services/billing");
const OwnerAgencies = require("../../services/ownerAgencies");
const Credits = require("../../services/credits");
const Plans = require("../../domain/plans");

jest.setTimeout(90000);

const DAY = 86400000;
const NOW = new Date("2026-06-01T12:00:00Z");
const days = (n, base = NOW) => new Date(base.getTime() + n * DAY);
let h;

beforeEach(async () => {
  h = await createHarness();
  // The harness database is shared by the tests of this file: put the prices back before each one.
  await h.query("UPDATE credit_plans SET prices = '{\"1\": 199, \"6\": 1075, \"12\": 1990}'::jsonb WHERE id = 'solo'");
  await Credits.refresh(h.pool);
  await h.seedBroker("owner");
  process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
  resetConfig();
});
afterAll(async () => {
  delete process.env.OWNER_BROKER_IDS;
  resetConfig();
  await closeHarness();
});

// The agency on a paid plan for `months` (its last confirmed payment) that ends in `daysLeft` days from `base` (negative: ended).
const setPaid = async (plan, months, daysLeft, base = NOW) => {
  await h.query("DELETE FROM payments WHERE agency_id = $1", [h.AGENCY_A]);
  await h.query("UPDATE agencies SET pilot = false, plan = $2, paid_until = $3, trial_ends_at = NULL, grace_extra_until = NULL, extra_seats = 0, locked_prices = NULL, lock_until = NULL, founding_partner = false WHERE id = $1", [h.AGENCY_A, plan, days(daysLeft, base).toISOString()]);
  if (months) await h.query("INSERT INTO payments (agency_id, kind, plan, months, amount_egp, reference, status, confirmed_at) VALUES ($1, 'plan', $2, $3, 100, $4, 'confirmed', $5)", [h.AGENCY_A, plan, months, `WH-S${Math.random().toString(36).slice(2, 8).toUpperCase()}`, days(-200, base).toISOString()]);
};
const owner = () => h.BROKERS.owner;
const platformOwner = () => h.BROKERS.admin;
const agencyRow = async () => (await h.query("SELECT * FROM agencies WHERE id = $1", [h.AGENCY_A]))[0];
const request = (input, now = NOW) => Billing.requestPayment(h.pool, owner(), input, { now });
const setPrices = async (plan, prices) => {
  await h.query("UPDATE credit_plans SET prices = $2::jsonb WHERE id = $1", [plan, JSON.stringify(prices)]);
  await Credits.refresh(h.pool);
};
const agencyShape = (over = {}) => ({ plan: "solo", paid_until: days(90), trial_ends_at: null, pilot: false, last_months: 6, ...over });

describe("5. upgrade quote (pure, injectable now)", () => {
  test("(new per month - current per month) x remaining days / 30, rounded to whole EGP", () => {
    // Solo 6 months 1,075 (179.17 a month) to Team 6 months 3,235 (539.17 a month): 360 a month x 3 months left.
    expect(Billing.quoteUpgrade(agencyShape(), "team", NOW)).toMatchObject({ ok: true, amount: 1080, detail: { from: "solo", to: "team", fromMonths: 6, toMonths: 6, remainingDays: 90 } });
    // Monthly Solo 199 to Team 599, 15 days left: 400 x 15/30.
    expect(Billing.quoteUpgrade(agencyShape({ last_months: 1, paid_until: days(15) }), "team", NOW).amount).toBe(200);
    // 12 months: 5,990 -> 17,900 is 992.5 a month; 100 days left = 3,308.33 -> 3,308.
    expect(Billing.quoteUpgrade(agencyShape({ plan: "team", last_months: 12, paid_until: days(100) }), "office", NOW).amount).toBe(3308);
    // Partial day counts as a whole remaining day.
    expect(Billing.quoteUpgrade(agencyShape({ last_months: 1, paid_until: new Date(NOW.getTime() + 15.2 * DAY) }), "team", NOW).detail.remainingDays).toBe(16);
  });

  test("Agency is never monthly: a monthly agency upgrading to it is priced on its shortest period (6 months: 2,691 a month)", () => {
    expect(Billing.quoteUpgrade(agencyShape({ last_months: 1, paid_until: days(30) }), "agency", NOW)).toMatchObject({ ok: true, amount: 2492, detail: { toMonths: 6 } });
    expect(Billing.quoteUpgrade(agencyShape({ plan: "office", last_months: 6, paid_until: days(30) }), "agency", NOW).detail.toMonths).toBe(6);
  });

  test("the price paid counts: a locked price is the current per-month figure", () => {
    const locked = { solo: { 6: 900 } };
    const a = agencyShape({ locked_prices: locked, lock_until: days(200) });
    // 900/6 = 150 a month instead of 179.17: (539.17 - 150) x 3 = 1,167.5 -> 1,168 (rounded from 1167.499..)
    expect(Billing.quoteUpgrade(a, "team", NOW).amount).toBe(Math.round(((3235 / 6 - 150) * 90) / 30));
    expect(Billing.quoteUpgrade(a, "team", NOW).detail.locked).toBe(true);
    // An expired lock is ignored.
    expect(Billing.quoteUpgrade(agencyShape({ locked_prices: locked, lock_until: days(-1) }), "team", NOW).amount).toBe(1080);
  });

  test("refused: lower or same plan, grace / read-only / blocked (renew instead), trial, pilot, unknown plan", () => {
    expect(Billing.quoteUpgrade(agencyShape({ plan: "team" }), "solo", NOW)).toEqual({ error: "downgrade" });
    expect(Billing.quoteUpgrade(agencyShape(), "solo", NOW)).toEqual({ error: "same_plan" });
    expect(Billing.quoteUpgrade(agencyShape(), "enterprise", NOW)).toEqual({ error: "plan" });
    for (const gone of [-1, -5, -30]) expect(Billing.quoteUpgrade(agencyShape({ paid_until: days(gone) }), "team", NOW)).toEqual({ error: "lapsed" });
    expect(Billing.quoteUpgrade(agencyShape({ pilot: true }), "team", NOW)).toEqual({ error: "not_paid" });
    expect(Billing.quoteUpgrade({ plan: "trial", paid_until: null, trial_ends_at: days(5), pilot: false }, "team", NOW)).toEqual({ error: "not_paid" });
  });

  test("upgradeQuotes lists only the higher plans", () => {
    expect(Object.keys(Billing.upgradeQuotes(agencyShape({ plan: "team", last_months: 6 }), NOW))).toEqual(["office", "agency"]);
    expect(Billing.upgradeQuotes(agencyShape({ plan: "agency", last_months: 6 }), NOW)).toEqual({});
  });
});

describe("5. upgrade payment (request and confirm)", () => {
  test("only the agency owner can request; the payment carries the quote, the target plan and the basis", async () => {
    await setPaid("solo", 6, 90);
    expect(await Billing.requestPayment(h.pool, h.BROKERS.admin, { kind: "upgrade", plan: "team" }, { now: NOW })).toEqual({ error: "forbidden" });
    const r = await request({ kind: "upgrade", plan: "team" });
    expect(r.ok).toBe(true);
    expect(r.payment).toMatchObject({ kind: "upgrade", plan: "team", amount_egp: 1080, status: "pending" });
    expect(r.payment.detail).toMatchObject({ from: "solo", to: "team", remainingDays: 90 });
    expect(r.payment.reference).toMatch(/^WH-/);
  });

  test("confirming changes the plan and leaves paid_until (and the lock, extra seats, referral) alone", async () => {
    await setPaid("solo", 6, 90);
    await h.query("UPDATE agencies SET extra_seats = 1 WHERE id = $1", [h.AGENCY_A]);
    const before = await agencyRow();
    const { payment } = await request({ kind: "upgrade", plan: "team" });
    const c = await Billing.confirmPayment(h.pool, payment.id, { now: NOW });
    expect(c.ok).toBe(true);
    expect(c.agency).toMatchObject({ plan: "team" });
    const after = await agencyRow();
    expect(new Date(after.paid_until)).toEqual(new Date(before.paid_until));
    expect(after.extra_seats).toBe(1);
    expect(after.locked_prices).toBeNull();
    expect(Billing.effectivePlan(after, NOW)).toMatchObject({ source: "paid", plan: { id: "team" } });
    // The later renewal is now for Team at the same length, and 'last_months' (the period length) did not change.
    expect(await request({ kind: "plan", plan: "team", months: 6 })).toMatchObject({ ok: true });
  });

  test("never in grace, read-only or blocked: renew instead", async () => {
    for (const gone of [-1, -4, -20]) {
      await setPaid("solo", 1, gone);
      expect(await request({ kind: "upgrade", plan: "team" })).toEqual({ error: "lapsed" });
      // Renewing works and any plan may be picked.
      expect(await request({ kind: "plan", plan: "team", months: 1 })).toMatchObject({ ok: true });
    }
  });

  test("a trial or a pilot cannot upgrade (they buy a plan), a lower plan and the same plan are refused", async () => {
    await h.query("UPDATE agencies SET pilot = true WHERE id = $1", [h.AGENCY_A]);
    expect(await request({ kind: "upgrade", plan: "team" })).toEqual({ error: "not_paid" });
    await setPaid("team", 6, 90);
    expect(await request({ kind: "upgrade", plan: "solo" })).toEqual({ error: "downgrade" });
    expect(await request({ kind: "upgrade", plan: "team" })).toEqual({ error: "same_plan" });
    expect(await request({ kind: "upgrade", plan: "nope" })).toEqual({ error: "plan" });
  });

  test("one upgrade at a time", async () => {
    await setPaid("solo", 6, 90);
    await request({ kind: "upgrade", plan: "team" });
    expect(await request({ kind: "upgrade", plan: "office" })).toEqual({ error: "upgrade_pending" });
  });

  test("an upgrade confirmed after the period ended (or after another upgrade) is refused and stays pending", async () => {
    await setPaid("solo", 6, 90);
    const { payment } = await request({ kind: "upgrade", plan: "team" });
    const gone = await Billing.confirmPayment(h.pool, payment.id, { now: days(120) });
    expect(gone).toMatchObject({ error: "upgrade_stale" });
    expect((await h.query("SELECT status FROM payments WHERE id = $1", [payment.id]))[0].status).toBe("pending");
    await h.query("UPDATE agencies SET plan = 'office' WHERE id = $1", [h.AGENCY_A]);
    expect(await Billing.confirmPayment(h.pool, payment.id, { now: NOW })).toMatchObject({ error: "upgrade_stale" });
  });
});

describe("6. no downgrade, no length switch, no refund logic (requestPayment)", () => {
  test("while paid: only the same plan for the same length, or an upgrade", async () => {
    await setPaid("team", 6, 90);
    expect(await request({ kind: "plan", plan: "solo", months: 6 })).toEqual({ error: "downgrade" });
    expect(await request({ kind: "plan", plan: "solo", months: 1 })).toEqual({ error: "downgrade" });
    expect(await request({ kind: "plan", plan: "team", months: 12 })).toEqual({ error: "period_switch" });
    expect(await request({ kind: "plan", plan: "team", months: 1 })).toEqual({ error: "period_switch" });
    expect(await request({ kind: "plan", plan: "office", months: 6 })).toEqual({ error: "upgrade_required" });
    expect(await request({ kind: "plan", plan: "agency", months: 12 })).toEqual({ error: "upgrade_required" });
    // Renewal at the same plan and length is allowed.
    expect(await request({ kind: "plan", plan: "team", months: 6 })).toMatchObject({ ok: true, payment: { kind: "plan", amount_egp: 3235 } });
  });

  test("6 to 12 months and 12 to 6 are both refused; monthly to 6 too", async () => {
    await setPaid("solo", 6, 30);
    expect(await request({ kind: "plan", plan: "solo", months: 12 })).toEqual({ error: "period_switch" });
    await setPaid("solo", 12, 200);
    expect(await request({ kind: "plan", plan: "solo", months: 6 })).toEqual({ error: "period_switch" });
    await setPaid("solo", 1, 10);
    expect(await request({ kind: "plan", plan: "solo", months: 6 })).toEqual({ error: "period_switch" });
    expect(await request({ kind: "plan", plan: "solo", months: 1 })).toMatchObject({ ok: true });
  });

  test("a renewal is queued: it extends from paid_until, not from today", async () => {
    await setPaid("team", 6, 90);
    const before = await agencyRow();
    const { payment } = await request({ kind: "plan", plan: "team", months: 6 });
    const c = await Billing.confirmPayment(h.pool, payment.id, { now: NOW });
    expect(c.ok).toBe(true);
    const [{ e }] = await h.query("SELECT ($1::timestamptz + interval '6 months') AS e", [new Date(before.paid_until).toISOString()]);
    expect(new Date((await agencyRow()).paid_until)).toEqual(new Date(e));
  });

  test("after expiry (grace, read-only, blocked) any plan and period may be chosen, down or switching length", async () => {
    for (const gone of [-1, -5, -40]) {
      await setPaid("office", 12, gone);
      expect(await request({ kind: "plan", plan: "solo", months: 1 })).toMatchObject({ ok: true });
      await h.query("DELETE FROM payments WHERE status = 'pending'");
      expect(await request({ kind: "plan", plan: "team", months: 6 })).toMatchObject({ ok: true });
      await h.query("DELETE FROM payments WHERE status = 'pending'");
    }
  });

  test("a trial or pilot agency buys any plan; a plan payment confirmed after the rules changed is refused, not applied", async () => {
    await h.query("UPDATE agencies SET pilot = false, paid_until = NULL, trial_ends_at = $2 WHERE id = $1", [h.AGENCY_A, days(5).toISOString()]);
    expect(await request({ kind: "plan", plan: "agency", months: 12 })).toMatchObject({ ok: true });
    await h.query("DELETE FROM payments");
    await setPaid("team", 6, 90);
    const { payment } = await request({ kind: "plan", plan: "team", months: 6 });
    await h.query("UPDATE agencies SET plan = 'office' WHERE id = $1", [h.AGENCY_A]);
    expect(await Billing.confirmPayment(h.pool, payment.id, { now: NOW })).toMatchObject({ error: "not_allowed" });
    expect((await agencyRow()).plan).toBe("office");
  });

  test("Agency and Enterprise cannot be bought monthly; only 6 and 12 months are offered; Enterprise is not sold", async () => {
    await setPaid("solo", 1, -40);
    expect(await request({ kind: "plan", plan: "agency", months: 1 })).toEqual({ error: "plan" });
    expect(await request({ kind: "plan", plan: "enterprise", months: 12 })).toEqual({ error: "plan" });
    expect(await request({ kind: "plan", plan: "solo", months: 3 })).toEqual({ error: "plan" });
    expect(Plans.periodsOf(Plans.planById("agency"))).toEqual([6, 12]);
    expect(Plans.priceFor(Plans.planById("agency"), 6)).toBe(16146);
    expect(Plans.priceFor(Plans.planById("agency"), 12)).toBe(29900);
    expect(Plans.PLANS.find((p) => p.id === "enterprise")).toBeUndefined();
    expect(await request({ kind: "plan", plan: "agency", months: 6 })).toMatchObject({ ok: true, payment: { amount_egp: 16146 } });
  });
});

describe("7. price lock and Founding Partner", () => {
  test("confirming a 12-month payment snapshots the prices and locks them for 12 months; shorter payments write no lock", async () => {
    await h.query("UPDATE agencies SET pilot = false, plan = 'solo', paid_until = NULL, trial_ends_at = NULL WHERE id = $1", [h.AGENCY_A]);
    const six = await request({ kind: "plan", plan: "solo", months: 6 });
    await Billing.confirmPayment(h.pool, six.payment.id, { now: NOW });
    expect((await agencyRow()).locked_prices).toBeNull();
    await h.query("UPDATE agencies SET paid_until = NULL WHERE id = $1", [h.AGENCY_A]);
    await h.query("DELETE FROM payments");
    const twelve = await request({ kind: "plan", plan: "solo", months: 12 });
    expect(twelve.payment.amount_egp).toBe(1990);
    await Billing.confirmPayment(h.pool, twelve.payment.id, { now: NOW });
    const a = await agencyRow();
    expect(a.locked_prices).toMatchObject({ solo: { 1: 199, 6: 1075, 12: 1990 }, team: { 12: 5990 }, agency: { 6: 16146, 12: 29900 } });
    expect(new Date(a.lock_until)).toEqual(new Date("2027-06-01T12:00:00Z"));
    expect(new Date(a.paid_until)).toEqual(new Date("2027-06-01T12:00:00Z"));
  });

  test("requestPayment uses the lock while it lasts; the lower of lock and list wins; an expired lock does not count", async () => {
    await setPaid("solo", 12, 100);
    await h.query("UPDATE agencies SET locked_prices = $2::jsonb, lock_until = $3 WHERE id = $1", [h.AGENCY_A, JSON.stringify({ solo: { 12: 1990 } }), days(100).toISOString()]);
    await setPrices("solo", { 1: 199, 6: 1075, 12: 2500 }); // the list went up
    let r = await request({ kind: "plan", plan: "solo", months: 12 });
    expect(r.payment.amount_egp).toBe(1990);
    expect(r.payment.detail).toMatchObject({ locked: true, list: 2500 });
    await h.query("DELETE FROM payments WHERE status = 'pending'");
    await setPrices("solo", { 1: 199, 6: 1075, 12: 1500 }); // the list went down: never pay more than the list
    r = await request({ kind: "plan", plan: "solo", months: 12 });
    expect(r.payment.amount_egp).toBe(1500);
    expect(r.payment.detail).toBeNull();
    await h.query("DELETE FROM payments WHERE status = 'pending'");
    await setPrices("solo", { 1: 199, 6: 1075, 12: 2500 });
    expect((await request({ kind: "plan", plan: "solo", months: 12 }, days(101))).payment.amount_egp).toBe(2500); // lock_until passed
  });

  test("a payment that used the lock consumes it; the next one pays the list", async () => {
    await setPaid("solo", 12, 100);
    await h.query("UPDATE agencies SET locked_prices = $2::jsonb, lock_until = $3 WHERE id = $1", [h.AGENCY_A, JSON.stringify({ solo: { 12: 1990 } }), days(100).toISOString()]);
    await setPrices("solo", { 1: 199, 6: 1075, 12: 2500 });
    const first = await request({ kind: "plan", plan: "solo", months: 12 });
    await Billing.confirmPayment(h.pool, first.payment.id, { now: NOW });
    const a = await agencyRow();
    expect(a.locked_prices).toBeNull();
    expect(a.lock_until).toBeNull();
    expect((await request({ kind: "plan", plan: "solo", months: 12 })).payment.amount_egp).toBe(2500);
  });

  test("Founding Partner: the first 12-month payment locks 24 months, so the first renewal can come late and still hold the price", async () => {
    await h.query("UPDATE agencies SET pilot = false, plan = 'solo', paid_until = NULL, trial_ends_at = NULL, founding_partner = true WHERE id = $1", [h.AGENCY_A]);
    const p = await request({ kind: "plan", plan: "solo", months: 12 });
    await Billing.confirmPayment(h.pool, p.payment.id, { now: NOW });
    expect(new Date((await agencyRow()).lock_until)).toEqual(new Date("2028-06-01T12:00:00Z"));
    await setPrices("solo", { 1: 199, 6: 1075, 12: 2500 });
    // 13 months later the period is long over (blocked); a late renewal is still at the locked price.
    const late = days(13 * 30);
    expect((await request({ kind: "plan", plan: "solo", months: 12 }, late)).payment.amount_egp).toBe(1990);
  });

  test("a plain agency's lock ends with its 12 months (a late renewal pays the list)", async () => {
    await h.query("UPDATE agencies SET pilot = false, plan = 'solo', paid_until = NULL, trial_ends_at = NULL WHERE id = $1", [h.AGENCY_A]);
    const p = await request({ kind: "plan", plan: "solo", months: 12 });
    await Billing.confirmPayment(h.pool, p.payment.id, { now: NOW });
    await setPrices("solo", { 1: 199, 6: 1075, 12: 2500 });
    expect((await request({ kind: "plan", plan: "solo", months: 12 }, days(13 * 30))).payment.amount_egp).toBe(2500);
    expect((await request({ kind: "plan", plan: "solo", months: 12 }, days(300))).payment.amount_egp).toBe(1990); // early renewal still locked
  });

  test("owner page: toggle, count of 20 used, refused when 20 are taken", async () => {
    const a = await signIn(h, "admin");
    const page = await a.agent.get("/app/owner?lang=en");
    expect(page.text).toContain('data-founding-count="0"');
    expect(page.text).toContain("0 of 20");
    expect(page.text).toContain("no setup fee, migration help");
    let res = await a.agent.post(`/app/owner/agencies/${h.AGENCY_A}/founding`).type("form").send({ _csrf: a.csrf, founding: "1" });
    expect(res.status).toBe(200);
    expect((await agencyRow()).founding_partner).toBe(true);
    expect(res.text).toContain("Used: 1 of 20");
    expect(await OwnerAgencies.foundingCount(h.pool)).toEqual({ used: 1, max: 20 });
    // Fill up to 20 with other agencies.
    for (let i = 0; i < 19; i++) await h.query("INSERT INTO agencies (id, name, phone, pilot, founding_partner) VALUES ($1, $2, '0200000000', true, true)", [crypto.randomUUID(), `Founding ${i}`]);
    expect(await OwnerAgencies.foundingCount(h.pool)).toEqual({ used: 20, max: 20 });
    res = await a.agent.post(`/app/owner/agencies/${h.AGENCY_B}/founding`).type("form").send({ _csrf: a.csrf, founding: "1" });
    expect(res.status).toBe(409);
    expect(res.text).toContain("All 20 Founding Partner places are taken");
    expect((await h.query("SELECT founding_partner FROM agencies WHERE id = $1", [h.AGENCY_B]))[0].founding_partner).toBe(false);
    // One that already has it can be saved again, and removed (freeing a place).
    res = await a.agent.post(`/app/owner/agencies/${h.AGENCY_A}/founding`).type("form").send({ _csrf: a.csrf, founding: "1" });
    expect(res.status).toBe(200);
    res = await a.agent.post(`/app/owner/agencies/${h.AGENCY_A}/founding`).type("form").send({ _csrf: a.csrf });
    expect(res.status).toBe(200);
    expect((await OwnerAgencies.foundingCount(h.pool)).used).toBe(19);
    // Only the platform owner: an agency owner gets the ordinary 404.
    const o = await signIn(h, "owner");
    expect((await o.agent.post(`/app/owner/agencies/${h.AGENCY_A}/founding`).type("form").send({ _csrf: o.csrf, founding: "1" })).status).toBe(404);
  });
});

describe("8. extra seats (hidden admin override)", () => {
  const add = (n, now = NOW, who = platformOwner()) => Billing.addExtraSeats(h.pool, who, h.AGENCY_A, n, { now });

  test("billed up front: 180 x seats x ceil(days left / 30) months, as a confirmed, referenced 'extra_seats' payment", async () => {
    await setPaid("solo", 12, 100); // 100 days = 4 months
    const r = await add(2);
    expect(r.ok).toBe(true);
    expect(r.extraSeats).toBe(2);
    expect(r.payment).toMatchObject({ kind: "extra_seats", status: "confirmed", seats: 2, months: 4, amount_egp: 1440 });
    expect(r.payment.reference).toMatch(/^WH-/);
    expect(r.payment.requested_by).toBe(h.BROKERS.admin.id);
    expect(r.payment.confirmed_at).not.toBeNull();
    expect((await agencyRow()).extra_seats).toBe(2);
    // Boundaries of the month count: 60 days = 2 months, 61 days = 3 months.
    await setPaid("solo", 12, 60);
    expect((await add(1)).payment).toMatchObject({ months: 2, amount_egp: 360 });
    await setPaid("solo", 12, 61);
    expect((await add(1)).payment).toMatchObject({ months: 3, amount_egp: 540 });
    await setPaid("solo", 12, 1);
    expect((await add(1)).payment).toMatchObject({ months: 1, amount_egp: 180 });
  });

  test("the seat limit is plan.seats + extra_seats, the credit pool +400 each (allowance output)", async () => {
    await setPaid("solo", 12, 100);
    let a = await Billing.allowance(h.pool, h.AGENCY_A, { now: NOW });
    expect(a.seats.limit).toBe(1);
    expect(a.credits.limit).toBe(400);
    await add(3);
    a = await Billing.allowance(h.pool, h.AGENCY_A, { now: NOW });
    expect(a).toMatchObject({ seats: { limit: 4 }, extraSeats: 3, credits: { limit: 1600, plan: 1600 } });
    expect((await Credits.poolFor(h.pool, h.AGENCY_A, "solo", { now: NOW })).total).toBe(1600);
    // The seat check used for inviting people sees it too: 3 active of 4, then 4 of 4.
    await h.query("UPDATE brokers SET is_active = false WHERE agency_id = $1", [h.AGENCY_A]);
    await h.query("UPDATE brokers SET is_active = true WHERE id = ANY($1::uuid[])", [[h.BROKERS.broker.id, h.BROKERS.colleague.id, h.BROKERS.admin.id]]);
    expect(await Billing.seatAvailable(h.pool, h.AGENCY_A, { now: NOW })).toBe(true);
    await h.query("UPDATE brokers SET is_active = true WHERE id = $1", [h.BROKERS.owner.id]);
    expect(await Billing.seatAvailable(h.pool, h.AGENCY_A, { now: NOW })).toBe(false);
  });

  test("grace AI rules include the extra seats: leftover of the last month's bigger pool, and 15% of the bigger pool for a 6/12 month plan", async () => {
    await setPaid("solo", 12, 100);
    await add(2); // pool 1,200
    await h.query("UPDATE agencies SET paid_until = $2 WHERE id = $1", [h.AGENCY_A, days(-1).toISOString()]);
    // In grace: nothing used last month, leftover is the whole 1,200 pool.
    expect((await Billing.allowance(h.pool, h.AGENCY_A, { now: NOW })).credits.limit).toBe(1200);
    // All of it used before the end: a long plan gets 15% of the pool with the extra seats (180), not of the plan alone (60).
    await h.query(
      `INSERT INTO operation_logs (agency_id, broker_id, operation_type, status, model_used, gemini_ms, metadata, created_at)
       SELECT $1, $2, 'listing_extraction', 'success', 'gemini-x', 10, '{}', $3 FROM generate_series(1, 1200)`,
      [h.AGENCY_A, h.BROKERS.broker.id, days(-2).toISOString()]
    );
    const a = await Billing.allowance(h.pool, h.AGENCY_A, { now: NOW });
    expect(a.source).toBe("grace");
    expect(a.seats.limit).toBe(3); // the extra seats stay while the agency is in grace
    expect(a.credits.limit).toBe(180);
  });

  test("0 or 5 seats and non-numbers are refused; beyond 4 in all is refused", async () => {
    await setPaid("solo", 12, 100);
    for (const bad of [0, 5, -1, 1.5, "x", null]) expect(await add(bad)).toEqual({ error: "invalid" });
    expect((await add(3)).ok).toBe(true);
    expect(await add(2)).toEqual({ error: "limit" });
    expect((await add(1)).ok).toBe(true);
    expect(await add(1)).toEqual({ error: "limit" });
    expect((await agencyRow()).extra_seats).toBe(4);
    // The database enforces it too.
    await expect(h.query("UPDATE agencies SET extra_seats = 5 WHERE id = $1", [h.AGENCY_A])).rejects.toThrow();
    expect(await Billing.addExtraSeats(h.pool, platformOwner(), "00000000-0000-0000-0000-00000000dead", 1, { now: NOW })).toEqual({ error: "not_found" });
  });

  test("not on a pilot, a trial, or in grace / read-only / blocked", async () => {
    await h.query("UPDATE agencies SET pilot = true WHERE id = $1", [h.AGENCY_A]);
    expect(await add(1)).toEqual({ error: "pilot" });
    await h.query("UPDATE agencies SET pilot = false, paid_until = NULL, trial_ends_at = $2 WHERE id = $1", [h.AGENCY_A, days(5).toISOString()]);
    expect(await add(1)).toEqual({ error: "not_paid" });
    for (const gone of [-1, -5, -30]) {
      await setPaid("solo", 1, gone);
      expect(await add(1)).toEqual({ error: "lapsed" });
    }
    expect((await agencyRow()).extra_seats).toBe(0);
    expect(await h.query("SELECT 1 FROM payments WHERE kind = 'extra_seats'")).toEqual([]);
  });

  test("only the platform owner (not the agency owner, not a manager) can add", async () => {
    await setPaid("solo", 12, 100);
    expect(await add(1, NOW, h.BROKERS.owner)).toEqual({ error: "forbidden" });
    expect(await add(1, NOW, h.BROKERS.broker)).toEqual({ error: "forbidden" });
    expect((await agencyRow()).extra_seats).toBe(0);
    await setPaid("solo", 12, 100, new Date()); // the page runs on the real clock
    // The route is the owner page: the agency owner gets 404, the platform owner is done.
    const o = await signIn(h, "owner");
    expect((await o.agent.post(`/app/owner/agencies/${h.AGENCY_A}/extra-seats`).type("form").send({ _csrf: o.csrf, seats: "1" })).status).toBe(404);
  });

  test("extra_seats resets to 0 when a new paid period starts after expiry, not on a renewal while active", async () => {
    await setPaid("solo", 6, 100);
    await add(2);
    // Renewal while active: kept.
    const renew = await request({ kind: "plan", plan: "solo", months: 6 });
    await Billing.confirmPayment(h.pool, renew.payment.id, { now: NOW });
    expect((await agencyRow()).extra_seats).toBe(2);
    // An upgrade while active: kept.
    const up = await request({ kind: "upgrade", plan: "team" });
    await Billing.confirmPayment(h.pool, up.payment.id, { now: NOW });
    expect((await agencyRow()).extra_seats).toBe(2);
    // Expired (read-only): the next payment starts a new period and the extras are gone.
    await setPaid("solo", 6, -5);
    await h.query("UPDATE agencies SET extra_seats = 2 WHERE id = $1", [h.AGENCY_A]);
    const again = await request({ kind: "plan", plan: "solo", months: 6 });
    const c = await Billing.confirmPayment(h.pool, again.payment.id, { now: NOW });
    expect(c.agency.extra_seats).toBe(0);
    expect((await agencyRow()).extra_seats).toBe(0);
    // Paying inside grace is also after expiry.
    await setPaid("solo", 6, -1);
    await h.query("UPDATE agencies SET extra_seats = 1 WHERE id = $1", [h.AGENCY_A]);
    const g = await request({ kind: "plan", plan: "solo", months: 6 });
    await Billing.confirmPayment(h.pool, g.payment.id, { now: NOW });
    expect((await agencyRow()).extra_seats).toBe(0);
  });

  test("owner page: the form adds seats and shows the reference; messages for the refusals; the owner log lists it", async () => {
    await setPaid("solo", 12, 100, new Date());
    const a = await signIn(h, "admin");
    const page = await a.agent.get(`/app/owner/agencies/${h.AGENCY_A}?lang=en`);
    expect(page.text).toContain('data-extra-seats="0"');
    expect(page.text).toContain("180 EGP a seat a month");
    let res = await a.agent.post(`/app/owner/agencies/${h.AGENCY_A}/extra-seats`).type("form").send({ _csrf: a.csrf, seats: "2" });
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Added 2 seat\(s\)\. Payment WH-[A-Z0-9]+: 1440 EGP/);
    expect((await agencyRow()).extra_seats).toBe(2);
    res = await a.agent.post(`/app/owner/agencies/${h.AGENCY_A}/extra-seats`).type("form").send({ _csrf: a.csrf, seats: "3" });
    expect(res.status).toBe(422);
    expect(res.text).toContain("At most 4 extra seats in all");
    res = await a.agent.post(`/app/owner/agencies/${h.AGENCY_A}/extra-seats`).type("form").send({ _csrf: a.csrf, seats: "9" });
    expect(res.status).toBe(422);
    expect((await OwnerAgencies.auditLog(h.pool)).some((x) => x.operation_type === "owner_extra_seats" && x.metadata.seats === 2)).toBe(true);
  });
});

describe("the Plan page (bilingual)", () => {
  const live = () => new Date();
  const pay = async (o, body) => o.agent.post("/app/plan/pay").type("form").send({ _csrf: o.csrf, ...body });

  test("paid plan: lower plans are not offered, same plan only for its own length, higher plans show the quoted amount", async () => {
    await setPaid("team", 6, 90, live());
    await h.query("UPDATE brokers SET preferred_lang = 'en' WHERE id = $1", [h.BROKERS.owner.id]);
    const o = await signIn(h, "owner");
    const page = await o.agent.get("/app/usage?lang=en");
    expect(page.status).toBe(200);
    expect(page.text).toContain("data-plan-rules");
    expect(page.text).not.toContain('data-plan-card="solo"');
    const team = page.text.slice(page.text.indexOf('data-plan-card="team"'));
    expect(team.slice(0, team.indexOf("</fieldset>"))).toContain('data-period="6"');
    expect(team.slice(0, team.indexOf("</fieldset>"))).not.toContain('data-period="12"');
    expect(page.text).toContain('data-upgrade-card');
    const q = Billing.quoteUpgrade(await Billing.agencyRow(h.pool, h.AGENCY_A), "office", live());
    expect(q.amount).toBe(3216); // (1,611 - 539.17) a month x 3 months
    expect(page.text).toContain(`data-upgrade-quote="${q.amount}"`);
    expect(page.text).toContain(`data-upgrade-to="office"`);
  });

  test("an upgrade button creates the pro-rated payment; the quote is the amount to pay", async () => {
    await setPaid("solo", 6, 90, live());
    const o = await signIn(h, "owner");
    const res = await pay(o, { choice: "upgrade:team" });
    expect(res.status).toBe(200);
    const [p] = await h.query("SELECT * FROM payments WHERE kind = 'upgrade'");
    expect(p).toMatchObject({ plan: "team", status: "pending" });
    expect(res.text).toContain(`data-payment="${p.reference}"`);
    expect(res.text).toContain(String(p.amount_egp).replace(/\B(?=(\d{3})+(?!\d))/g, ","));
  });

  test("clear errors in Arabic and English for downgrade and length switch, and for an upgrade after expiry", async () => {
    await setPaid("team", 6, 90, live());
    const o = await signIn(h, "owner"); // owner prefers Arabic
    let res = await pay(o, { kind: "plan", choice: "solo:6" });
    expect(res.status).toBe(400);
    expect(res.text).toContain('data-plan-error="downgrade"');
    expect(res.text).toContain("لباقة أقل");
    res = await pay(o, { kind: "plan", choice: "team:12" });
    expect(res.text).toContain('data-plan-error="period_switch"');
    expect(res.text).toContain("مدة الباقة");
    res = await pay(o, { kind: "plan", choice: "office:6" });
    expect(res.text).toContain('data-plan-error="upgrade_required"');
    await h.query("UPDATE brokers SET preferred_lang = 'en' WHERE id = $1", [h.BROKERS.owner.id]);
    const e = await signIn(h, "owner");
    res = await pay(e, { kind: "plan", choice: "solo:6" });
    expect(res.text).toContain("You can&#39;t move to a lower plan");
    res = await pay(e, { kind: "plan", choice: "team:12" });
    expect(res.text).toContain("another length after the period ends");
    // Same plan, same length works.
    res = await pay(e, { kind: "plan", choice: "team:6" });
    expect(res.status).toBe(200);
    // After expiry the Plan page offers everything again (cards), and an upgrade request says renew instead.
    await setPaid("team", 6, -1, live());
    const page = await e.agent.get("/app/usage?lang=en");
    expect(page.text).toContain('data-plan-card="solo"');
    expect(page.text).not.toContain("data-upgrade-card");
    res = await pay(e, { choice: "upgrade:office" });
    expect(res.status).toBe(400);
    expect(res.text).toContain("renew instead of upgrading");
  });

  test("the agency never sees the extra-seats record, only the totals", async () => {
    await setPaid("solo", 12, 100, live());
    const r = await Billing.addExtraSeats(h.pool, platformOwner(), h.AGENCY_A, 2);
    const o = await signIn(h, "owner");
    const page = await o.agent.get("/app/usage?lang=en");
    expect(page.status).toBe(200);
    expect(page.text).not.toContain(r.payment.reference);
    expect(page.text).toMatch(/data-meter="seats"[^]*?<strong>\d+ \/ 3<\/strong>/);
    expect(page.text).toContain("1,200");
  });
});

describe("migration 130 constraints", () => {
  test("payments accept the new kinds with their shape and reject bad ones", async () => {
    const ins = (kind, plan, months, seats = null) => h.query("INSERT INTO payments (agency_id, kind, plan, months, amount_egp, reference, seats) VALUES ($1, $2, $3, $4, 100, $5, $6)", [h.AGENCY_A, kind, plan, months, `WH-C${Math.random().toString(36).slice(2, 8).toUpperCase()}`, seats]);
    await ins("upgrade", "team", 6);
    await ins("extra_seats", null, 14, 2);
    await expect(ins("upgrade", null, 6)).rejects.toThrow(); // an upgrade names its target plan
    await expect(ins("extra_seats", "team", 3, 1)).rejects.toThrow(); // extra seats have no plan
    await expect(ins("extra_seats", null, 3, 5)).rejects.toThrow(); // 1..4 seats
    await expect(ins("bogus", null, 1)).rejects.toThrow();
  });
});
