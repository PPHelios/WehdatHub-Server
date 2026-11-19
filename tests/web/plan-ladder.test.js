// tests/web/plan-ladder.test.js — Phase 2 of the new pricing: the expiry ladder after a paid or trial period ends.
// Paid monthly: 3 days grace, 7 days read-only, then blocked. Paid 6/12 months: 7 / 14. Trial: no grace, 7 days read-only, then
// blocked. No Free step for an agency that ever had a trial or paid period. Derived from dates in effectivePlan (injectable `now`).
// Also: the AI pool in grace, a pending payment pausing the clock, restore on payment, the central guard per area (web, API, bot,
// AI, new links), the owner's grace extension and Plans-form prices, and the notifications along the ladder (deduped per end date).
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness, textOf } = require("../harness/app");
const { signIn } = require("../harness/web");
const { resetConfig } = require("../../config");
const WebAuth = require("../../lib/webAuth");
const Billing = require("../../services/billing");
const BillingNotices = require("../../services/billingNotices");
const Credits = require("../../services/credits");
const Plans = require("../../domain/plans");
const PlanGuard = require("../../lib/planGuard");
const ShareLinks = require("../../lib/shareLinks");

jest.setTimeout(90000);

const DAY = 86400000;
const E = new Date("2026-03-01T00:00:00Z"); // a period end
const at = (days) => new Date(E.getTime() + days * DAY);
let h;

beforeEach(async () => {
  h = await createHarness();
  // These tests move plan dates straight in the database, so the 15 s plan-state memo must be dropped on every write.
  const query = h.query;
  h.query = async (...args) => { const r = await query(...args); PlanGuard.forget(h.AGENCY_A); return r; };
  await Credits.refresh(h.pool); // the plans of this fresh database, not the last test's
  process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
  resetConfig();
});
afterAll(async () => {
  delete process.env.OWNER_BROKER_IDS;
  resetConfig();
  await closeHarness();
});

// The agency as effectivePlan reads it.
const row = (over = {}) => ({ plan: "solo", paid_until: E, trial_ends_at: null, pilot: false, last_months: 1, ...over });
const src = (agency, now) => Billing.effectivePlan(agency, now).source;
// Real-clock fixtures for the integration tests: the period ended `daysAgo` days ago.
// graceExtraDays: the owner's manual extension (grace_extra_until = now + that many days), none by default.
const endedAgo = (daysAgo, graceExtraDays = null) =>
  h.query("UPDATE agencies SET pilot = false, plan = 'solo', paid_until = $2, trial_ends_at = NULL, grace_extra_until = CASE WHEN $3::numeric IS NULL THEN NULL ELSE NOW() + $3::numeric * INTERVAL '1 day' END WHERE id = $1", [h.AGENCY_A, new Date(Date.now() - daysAgo * DAY).toISOString(), graceExtraDays]);
const beforeEnd = (daysAgo) => new Date(Date.now() - daysAgo * DAY - 3600 * 1000); // an hour before the period ended
const longPlan = () => h.query("INSERT INTO payments (agency_id, kind, plan, months, amount_egp, reference, status, confirmed_at) VALUES ($1, 'plan', 'solo', 6, 1075, $2, 'confirmed', NOW() - INTERVAL '90 days')", [h.AGENCY_A, `WH-L${Math.random().toString(36).slice(2, 7).toUpperCase()}`]);
const useAi = (n, when = new Date()) =>
  h.query(
    `INSERT INTO operation_logs (agency_id, broker_id, operation_type, status, model_used, gemini_ms, metadata, created_at)
     SELECT $1, $2, 'listing_extraction', 'success', 'gemini-x', 10, '{}', $3 FROM generate_series(1, $4)`,
    [h.AGENCY_A, h.BROKERS.broker.id, when.toISOString(), n]
  );

describe("phase boundaries (derived from dates, injectable now)", () => {
  test("monthly plan: paid, 3 days grace, 7 days read-only, then blocked; never Free", () => {
    const a = row();
    expect([src(a, at(-0.001)), src(a, at(0)), src(a, at(2.999)), src(a, at(3)), src(a, at(9.999)), src(a, at(10)), src(a, at(400))]).toEqual(["paid", "grace", "grace", "readonly", "readonly", "blocked", "blocked"]);
    const g = Billing.effectivePlan(a, at(1));
    expect(g).toMatchObject({ source: "grace", kind: "monthly", plan: { id: "solo" } });
    expect(g.until).toEqual(at(3));
    expect(g.readonlyStarts).toEqual(at(3));
    expect(g.blockedStarts).toEqual(at(10));
    expect(Billing.effectivePlan(a, at(10)).until).toBeNull();
  });

  test("a plan last paid for 6 or 12 months: 7 days grace, 14 days read-only, then blocked", () => {
    const a = row({ last_months: 12 });
    expect([src(a, at(0)), src(a, at(6.999)), src(a, at(7)), src(a, at(20.999)), src(a, at(21))]).toEqual(["grace", "grace", "readonly", "readonly", "blocked"]);
    expect(Billing.effectivePlan(a, at(1)).kind).toBe("long");
    expect(src(row({ last_months: 6 }), at(7))).toBe("readonly");
    expect(src(row({ last_months: 1 }), at(7))).toBe("readonly"); // monthly: read-only from day 3
    expect(src(row({ last_months: 1 }), at(10))).toBe("blocked");
  });

  test("trial: no grace, read-only for 7 days after it ends, then blocked", () => {
    const t = { plan: "trial", trial_ends_at: E, paid_until: null, pilot: false };
    expect([src(t, at(-0.001)), src(t, at(0)), src(t, at(6.999)), src(t, at(7)), src(t, at(30))]).toEqual(["trial", "readonly", "readonly", "blocked", "blocked"]);
    expect(Billing.effectivePlan(t, at(1))).toMatchObject({ kind: "trial", plan: { id: "trial" } });
  });

  test("no Free step after a trial or paid period; an agency with neither keeps Free; a pilot is untouched", () => {
    expect(src({ plan: "solo", paid_until: null, trial_ends_at: null, pilot: false }, at(0))).toBe("free");
    expect(Billing.effectivePlan({ plan: "solo", pilot: false }, at(0)).plan.id).toBe("free");
    for (const d of [0, 5, 50, 500]) {
      expect(src(row(), at(d))).not.toBe("free");
      expect(src({ plan: "trial", trial_ends_at: E, pilot: false }, at(d))).not.toBe("free");
    }
    expect(src({ pilot: true, plan: "office", paid_until: E }, at(500))).toBe("pilot");
  });

  test("a pending plan payment holds the clock for at most 3 days; a cancelled one lets it run on", () => {
    const pending = (p) => row({ pending_plan_at: p });
    // Announced on day 1: the clock stands still until it is confirmed or 3 days passed.
    expect(src(pending(at(1)), at(3.5))).toBe("grace"); // would be read-only without the payment
    expect(src(pending(at(1)), at(4.5))).toBe("grace"); // 3.5 days waited, held 3: clock at day 1.5
    expect(src(pending(at(1)), at(6.5))).toBe("readonly"); // clock at day 3.5
    expect(src(pending(at(1)), at(12.9))).toBe("readonly"); // held 3 days only: clock at day 9.9
    expect(src(pending(at(1)), at(13))).toBe("blocked"); // clock at day 10
    expect(src(row(), at(3.5))).toBe("readonly"); // cancelled: no hold
    // Announced before the period ended: the hold starts at the end.
    expect(src(pending(at(-2)), at(2.9))).toBe("grace");
    expect(src(pending(at(-2)), at(5.9))).toBe("grace"); // held 3 days: clock at 2.9
    expect(src(pending(at(-2)), at(6.1))).toBe("readonly");
    // Also for the long ladder.
    expect(src(row({ last_months: 6, pending_plan_at: at(2) }), at(9.5))).toBe("grace");
    expect(Billing.PENDING_HOLD_MS).toBe(3 * DAY);
  });

  test("the owner's grace extension moves read-only and blocked later (grace_extra_until)", () => {
    const a = row({ grace_extra_until: at(8) });
    expect([src(a, at(5)), src(a, at(7.99)), src(a, at(8)), src(a, at(14.99)), src(a, at(15))]).toEqual(["grace", "grace", "readonly", "readonly", "blocked"]);
    // A shorter extension than the normal grace changes nothing; a trial has no grace to extend.
    expect(src(row({ grace_extra_until: at(1) }), at(2))).toBe("grace");
    expect(src(row({ grace_extra_until: at(1) }), at(3))).toBe("readonly");
    expect(src({ plan: "trial", trial_ends_at: E, pilot: false, grace_extra_until: at(30) }, at(1))).toBe("readonly");
  });
});

describe("AI credits along the ladder", () => {
  test("trial: 80 credits are one allowance for the whole trial, not a monthly one", async () => {
    await h.query("UPDATE agencies SET pilot = false, plan = 'trial', paid_until = NULL, trial_ends_at = NOW() + INTERVAL '3 days', signed_up_at = NOW() - INTERVAL '40 days' WHERE id = $1", [h.AGENCY_A]);
    await useAi(50, new Date(Date.now() - 35 * DAY)); // last month, same trial
    await useAi(29);
    expect(await Credits.usedThisMonth(h.pool, h.AGENCY_A)).toBe(29); // the month alone would say 29
    const a = await Billing.allowance(h.pool, h.AGENCY_A);
    expect(a).toMatchObject({ source: "trial", credits: { used: 79, limit: 80 } });
    await expect(Billing.checkAllowance(h.pool, h.AGENCY_A)).resolves.toMatchObject({ used: 79, limit: 80 });
    await useAi(1);
    await expect(Billing.checkAllowance(h.pool, h.AGENCY_A)).rejects.toMatchObject({ code: "PLAN_QUOTA_EXCEEDED", trial: true, used: 80, limit: 80 });
  });

  test("grace, monthly plan: only what was left of the last paid month, no refill", async () => {
    await endedAgo(1);
    await useAi(100, beforeEnd(1)); // before paid_until (Solo = 400)
    const a = await Billing.allowance(h.pool, h.AGENCY_A);
    expect(a).toMatchObject({ source: "grace", credits: { used: 0, limit: 300, bundles: 0, grants: 0 } });
    await useAi(20); // in grace
    expect((await Billing.allowance(h.pool, h.AGENCY_A)).credits).toMatchObject({ used: 20, limit: 300 });
    // Nothing is added for the plan's new month.
    expect((await Billing.allowance(h.pool, h.AGENCY_A)).credits.limit).toBe(300);
  });

  test("grace, 6/12-month plan: the greater of the leftover and grace_ai_pct % of one month, not both", async () => {
    await endedAgo(1);
    await longPlan();
    // Leftover 300 beats 15% of 400 = 60.
    await useAi(100, beforeEnd(1));
    expect((await Billing.allowance(h.pool, h.AGENCY_A)).credits).toMatchObject({ limit: 300 });
    // Leftover 10 (390 used) loses to 60.
    await useAi(290, beforeEnd(1));
    expect((await Billing.allowance(h.pool, h.AGENCY_A)).credits).toMatchObject({ limit: 60 });
    // The owner tunes the share.
    await Billing.setSetting(h.pool, "grace_ai_pct", 50);
    expect(await Billing.graceAiPct(h.pool)).toBe(50);
    expect((await Billing.allowance(h.pool, h.AGENCY_A)).credits.limit).toBe(200);
    await Billing.setSetting(h.pool, "grace_ai_pct", 15);
    await useAi(60); // spend the 60 in grace
    await expect(Billing.checkAllowance(h.pool, h.AGENCY_A)).rejects.toMatchObject({ code: "PLAN_QUOTA_EXCEEDED", grace: true, limit: 60, used: 60 });
  });

  test("read-only and blocked: no AI at all (PLAN_EXPIRED), and the aiBlock text says why", async () => {
    const AiBlock = require("../../lib/aiBlock");
    for (const [days, phase] of [[5, "readonly"], [15, "blocked"]]) {
      await endedAgo(days);
      const err = await Billing.checkAllowance(h.pool, h.AGENCY_A).catch((e) => e);
      expect(err).toMatchObject({ code: "PLAN_EXPIRED", phase });
      expect(AiBlock.kindOf(err)).toBe("plan");
      expect(AiBlock.text("plan", "en", { owner: true })).toContain("/app/usage#plan");
      expect(AiBlock.text("plan", "en", { owner: false })).toMatch(/manager/);
      expect(AiBlock.BLOCKS).toContain(AiBlock.kindOf(err));
    }
    // The AI gateway stops before calling the model.
    const AI = jest.requireActual("../../lib/ai");
    AI._setClientForTests({ models: { generateContent: async () => ({ text: "ok", usageMetadata: {} }) } });
    try {
      await endedAgo(5);
      await expect(AI.generateWithCascade({ contents: "hello", operationType: "listing_extraction", ctx: { pool: h.pool, broker: { id: h.BROKERS.broker.id, agency_id: h.AGENCY_A } } })).rejects.toMatchObject({ code: "PLAN_EXPIRED" });
    } finally {
      AI._setClientForTests(null);
    }
  });

  test("a paid agency in its period is untouched: the month's pool and bundles", async () => {
    await h.query("UPDATE agencies SET pilot = false, plan = 'solo', paid_until = NOW() + INTERVAL '10 days' WHERE id = $1", [h.AGENCY_A]);
    expect(await Billing.allowance(h.pool, h.AGENCY_A)).toMatchObject({ source: "paid", ladder: null, credits: { limit: 400, plan: 400 } });
  });
});

describe("top-ups and restoring on payment", () => {
  test("credit bundles and credit requests are refused in grace, read-only and blocked; a plan payment is not", async () => {
    await h.seedBroker("owner");
    const owner = h.BROKERS.owner;
    for (const days of [1, 5, 15]) {
      await endedAgo(days);
      expect(await Billing.requestPayment(h.pool, owner, { kind: "credit_bundle", bundle: "small" })).toEqual({ error: "lapsed" });
      expect(await Credits.requestMore(h.pool, owner, { credits: 100 })).toEqual({ error: "lapsed" });
      expect(await Billing.requestPayment(h.pool, owner, { kind: "plan", plan: "solo", months: 1 })).toMatchObject({ ok: true });
      await h.query("DELETE FROM payments");
    }
    await h.query("UPDATE agencies SET paid_until = NOW() + INTERVAL '10 days' WHERE id = $1", [h.AGENCY_A]);
    expect(await Billing.requestPayment(h.pool, owner, { kind: "credit_bundle", bundle: "small" })).toMatchObject({ ok: true });
  });

  const pay = async (months = 1) => {
    await h.seedBroker("owner");
    const r = await Billing.requestPayment(h.pool, h.BROKERS.owner, { kind: "plan", plan: "solo", months });
    return r.payment;
  };
  const gapDays = (a, b) => (new Date(a) - new Date(b)) / DAY;

  test("paid inside grace: the new period starts at the old paid_until (grace days are not free days)", async () => {
    await endedAgo(1, 5);
    const [{ paid_until: old }] = await h.query("SELECT paid_until FROM agencies WHERE id = $1", [h.AGENCY_A]);
    const p = await pay(1);
    const r = await Billing.confirmPayment(h.pool, p.id);
    expect(r.restored).toEqual({ from: "grace" });
    expect(gapDays(r.agency.paid_until, old)).toBeGreaterThan(27);
    expect(gapDays(r.agency.paid_until, old)).toBeLessThan(32);
    expect((await h.query("SELECT grace_extra_until FROM agencies WHERE id = $1", [h.AGENCY_A]))[0].grace_extra_until).toBeNull();
    expect(Billing.effectivePlan(r.agency).source).toBe("paid");
  });

  test("paid in read-only or blocked: the new period starts today; full access at once", async () => {
    for (const [days, from] of [[5, "readonly"], [15, "blocked"]]) {
      await h.query("DELETE FROM payments");
      await endedAgo(days);
      const p = await pay(6);
      const r = await Billing.confirmPayment(h.pool, p.id);
      expect(r.restored).toEqual({ from });
      expect(gapDays(r.agency.paid_until, new Date())).toBeGreaterThan(180);
      expect(gapDays(r.agency.paid_until, new Date())).toBeLessThan(186);
      expect(Billing.effectivePlan(r.agency).source).toBe("paid");
    }
  });

  test("paid while the plan still runs: queued after the current end; no restore", async () => {
    await h.query("UPDATE agencies SET pilot = false, plan = 'solo', paid_until = NOW() + INTERVAL '10 days' WHERE id = $1", [h.AGENCY_A]);
    const [{ paid_until: old }] = await h.query("SELECT paid_until FROM agencies WHERE id = $1", [h.AGENCY_A]);
    const r = await Billing.confirmPayment(h.pool, (await pay(1)).id);
    expect(r.restored).toBeNull();
    expect(gapDays(r.agency.paid_until, old)).toBeGreaterThan(27);
  });

  test("a pending payment pauses the clock in the live agency row; cancelling it lets the clock run", async () => {
    await endedAgo(3.5); // would be read-only
    expect((await Billing.allowance(h.pool, h.AGENCY_A)).source).toBe("readonly");
    await h.seedBroker("owner");
    const p = (await Billing.requestPayment(h.pool, h.BROKERS.owner, { kind: "plan", plan: "solo", months: 1 })).payment;
    await h.query("UPDATE payments SET created_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [p.id]);
    // Announced an hour ago: held for that hour, the clock reads 3.46 days: still read-only.
    expect((await Billing.allowance(h.pool, h.AGENCY_A)).source).toBe("readonly");
    await h.query("UPDATE payments SET created_at = NOW() - INTERVAL '14 hours' WHERE id = $1", [p.id]);
    expect((await Billing.allowance(h.pool, h.AGENCY_A)).source).toBe("grace"); // held 14 h: the clock reads 2.92 days
    await h.query("UPDATE payments SET created_at = NOW() - INTERVAL '20 hours' WHERE id = $1", [p.id]);
    expect((await Billing.allowance(h.pool, h.AGENCY_A)).source).toBe("grace");
    await Billing.cancelPayment(h.pool, p.id);
    expect((await Billing.allowance(h.pool, h.AGENCY_A)).source).toBe("readonly");
  });
});

describe("the owner extends grace", () => {
  test("+3 or +7 days from the later of now and the grace end; a trial, an unknown amount and a pilot are refused", async () => {
    expect(await Billing.extendGrace(h.pool, h.AGENCY_A, 3)).toEqual({ error: "not_found" }); // the harness agency is a pilot
    await endedAgo(1);
    expect(await Billing.extendGrace(h.pool, h.AGENCY_A, 5)).toEqual({ error: "days" });
    const now = new Date();
    const r = await Billing.extendGrace(h.pool, h.AGENCY_A, 3, { now });
    const [{ paid_until }] = await h.query("SELECT paid_until FROM agencies WHERE id = $1", [h.AGENCY_A]);
    expect(new Date(r.agency.grace_extra_until).getTime()).toBe(new Date(paid_until).getTime() + 3 * DAY + 3 * DAY); // grace end (end + 3d) + 3d
    // Read-only → back to grace for 7 days from now.
    await endedAgo(5);
    const r2 = await Billing.extendGrace(h.pool, h.AGENCY_A, 7, { now });
    expect(new Date(r2.agency.grace_extra_until).getTime()).toBe(now.getTime() + 7 * DAY);
    expect((await Billing.allowance(h.pool, h.AGENCY_A)).source).toBe("grace");
    // A trial has none.
    await h.query("UPDATE agencies SET paid_until = NULL, trial_ends_at = NOW() - INTERVAL '1 day' WHERE id = $1", [h.AGENCY_A]);
    expect(await Billing.extendGrace(h.pool, h.AGENCY_A, 3)).toEqual({ error: "not_lapsed" });
  });

  test("the owner page lists lapsed agencies with +3 / +7 buttons and the route extends", async () => {
    await endedAgo(1);
    const a = await signIn(h, "admin");
    const page = await a.agent.get("/app/owner?lang=en");
    expect(page.text).toContain(`data-grace-agency="${h.AGENCY_A}"`);
    const res = await a.agent.post(`/app/owner/grace/${h.AGENCY_A}/extend`).type("form").send({ _csrf: a.csrf, days: "7" });
    expect(res.status).toBe(200);
    expect((await h.query("SELECT grace_extra_until FROM agencies WHERE id = $1", [h.AGENCY_A]))[0].grace_extra_until).not.toBeNull();
    expect((await a.agent.post(`/app/owner/grace/${h.AGENCY_A}/extend`).type("form").send({ _csrf: a.csrf, days: "4" })).status).toBe(400);
  });
});

describe("the central guard (web, API, bot, links)", () => {
  test("webDecision per area, per phase (pure)", () => {
    const d = (source, method, path) => PlanGuard.webDecision(source, method, path);
    for (const phase of ["paid", "trial", "grace", "pilot", "free"]) expect(d(phase, "POST", "/units/new")).toBe("ok");
    // Read-only: reads and local search work; writes, imports, AI and flyers do not.
    expect(["/units", "/units/AP-1", "/leads", "/search", "/units-export.xlsx", "/usage", "/links", "/dashboard"].map((p) => d("readonly", "GET", p))).toEqual(Array(8).fill("ok"));
    expect(["/units/new", "/units/AP-1/edit", "/units/AP-1/flyer", "/leads/new", "/leads/import", "/import", "/add", "/deals/new"].map((p) => d("readonly", "GET", p))).toEqual(Array(8).fill("plan"));
    expect(["/units/new", "/units/AP-1/delete", "/units/AP-1/status", "/units/AP-1/share", "/units/bulk", "/leads/new", "/leads/L-1/stage", "/import/excel", "/import/group", "/leads/import", "/compare", "/search/voice", "/ask", "/deals/new", "/team/invite", "/plan/credit-request"].map((p) => d("readonly", "POST", p))).toEqual(Array(16).fill("deny"));
    expect(["/plan/pay", "/logout", "/settings", "/notifications/1/read", "/searches"].map((p) => d("readonly", "POST", p))).toEqual(Array(5).fill("ok"));
    // Blocked: the plan and payment page and the export only.
    expect(["/usage", "/plan", "/units-export.xlsx", "/logout"].map((p) => d("blocked", "GET", p))).toEqual(Array(4).fill("ok"));
    expect(["/", "/units", "/leads", "/search", "/dashboard", "/units/new"].map((p) => d("blocked", "GET", p))).toEqual(Array(6).fill("plan"));
    expect(d("blocked", "POST", "/plan/pay")).toBe("ok");
    expect(d("blocked", "POST", "/leads/new")).toBe("deny");
    // The API.
    expect(PlanGuard.apiDecision("readonly", "GET", "/units")).toBe("ok");
    expect(PlanGuard.apiDecision("readonly", "POST", "/units")).toBe("deny");
    expect(PlanGuard.apiDecision("readonly", "POST", "/leads")).toBe("deny");
    expect(PlanGuard.apiDecision("readonly", "POST", "/plan/pay")).toBe("ok");
    expect(PlanGuard.apiDecision("blocked", "GET", "/units")).toBe("deny");
    expect(PlanGuard.apiDecision("blocked", "GET", "/plan")).toBe("ok");
    expect(PlanGuard.apiDecision("grace", "POST", "/units")).toBe("ok");
  });

  test("web, read-only: the banner shows; view and export work; add, edit, delete, import, share, compare, flyer, AI and top-ups do not; paying does", async () => {
    await h.seedBroker("owner");
    await endedAgo(5);
    const unit = await h.insertListing({ code: "RO-1" });
    const o = await signIn(h, "owner");
    const list = await o.agent.get("/app/units?lang=en");
    expect(list.status).toBe(200);
    expect(list.text).toContain('data-plan-banner="readonly"');
    expect(list.text).toMatch(/read-only/i);
    expect((await o.agent.get(`/app/units/${unit.code}?lang=en`)).status).toBe(200);
    expect((await o.agent.get("/app/search?q=apartment&lang=en")).status).toBe(200); // the local parser: AI is refused below it
    const exp = await o.agent.get("/app/units-export.xlsx");
    expect(exp.status).toBe(200);
    for (const path of ["/app/units/new", "/app/leads/new", "/app/import", `/app/units/${unit.code}/edit`, `/app/units/${unit.code}/flyer`]) {
      const r = await o.agent.get(path).redirects(0);
      expect([path, r.status, r.headers.location]).toEqual([path, 303, "/app/usage#plan"]);
    }
    for (const [path, body] of [
      ["/app/units/new", {}],
      [`/app/units/${unit.code}/delete`, {}],
      [`/app/units/${unit.code}/status`, { status: "sold" }],
      [`/app/units/${unit.code}/share`, {}],
      ["/app/leads/new", { name: "X", phone1: "01155550101" }],
      ["/app/import/excel", {}],
      ["/app/compare", { codes: "RO-1,RO-2" }],
      ["/app/search/voice", {}],
      ["/app/plan/credit-request", { credits: "100" }]
    ]) {
      const r = await o.agent.post(path).type("form").send({ _csrf: o.csrf, ...body });
      expect([path, r.status]).toEqual([path, 402]);
    }
    expect(await h.query("SELECT 1 FROM listings WHERE code = 'RO-1' AND status = 'active'")).toHaveLength(1);
    const usage = await o.agent.get("/app/usage?lang=en");
    expect(usage.status).toBe(200);
    expect(usage.text).toContain('data-source="readonly"');
    expect(usage.text).not.toContain("data-bundles"); // top-ups need an active plan
    const payRes = await o.agent.post("/app/plan/pay").type("form").send({ _csrf: o.csrf, kind: "plan", choice: "solo:1" });
    expect(payRes.status).toBe(200);
    const bundle = await o.agent.post("/app/plan/pay").type("form").send({ _csrf: o.csrf, kind: "credit_bundle", bundle: "small" });
    expect(bundle.status).toBe(400);
  });

  test("web, read-only: a broker is told to ask the manager and sees no prices and no payment link", async () => {
    await endedAgo(5);
    const b = await signIn(h, "broker");
    const list = await b.agent.get("/app/units?lang=en");
    expect(list.text).toContain('data-plan-banner="readonly"');
    expect(list.text).toMatch(/Ask your manager/);
    expect(list.text).not.toMatch(/\/app\/usage#plan"/);
    const r = await b.agent.get("/app/units/new?lang=en");
    expect(r.status).toBe(403);
    expect(r.text).toContain('data-plan-ended="readonly"');
    expect(r.text).toMatch(/Ask your manager/);
    expect(r.text).not.toMatch(/EGP|ج\.م/);
    expect((await b.agent.post("/app/leads/new").type("form").send({ _csrf: b.csrf, name: "X", phone1: "01155550101" })).status).toBe(402);
  });

  test("web, blocked: everything goes to the plan page except export and paying; a broker gets 'ask your manager'", async () => {
    await h.seedBroker("owner");
    const o = await signIn(h, "owner"); // signed in while the plan ran (a blocked agency's home redirects to the plan page)
    const b = await signIn(h, "broker");
    await endedAgo(15);
    for (const path of ["/app/", "/app/units", "/app/leads", "/app/search", "/app/dashboard"]) {
      const r = await o.agent.get(path).redirects(0);
      expect([path, r.status, r.headers.location]).toEqual([path, 303, "/app/usage#plan"]);
    }
    const usage = await o.agent.get("/app/usage?lang=en");
    expect(usage.status).toBe(200);
    expect(usage.text).toContain('data-plan-banner="blocked"');
    expect((await o.agent.get("/app/units-export.xlsx")).status).toBe(200);
    expect((await o.agent.post("/app/leads/new").type("form").send({ _csrf: o.csrf, name: "X" })).status).toBe(402);
    expect((await o.agent.post("/app/plan/pay").type("form").send({ _csrf: o.csrf, kind: "plan", choice: "solo:1" })).status).toBe(200);
    const r = await b.agent.get("/app/units?lang=en");
    expect(r.status).toBe(403);
    expect(r.text).toContain('data-plan-ended="blocked"');
    expect(r.text).not.toMatch(/EGP/);
    // Data is never deleted.
    expect((await h.query("SELECT count(*)::int AS n FROM brokers WHERE agency_id = $1", [h.AGENCY_A]))[0].n).toBeGreaterThan(1);
  });

  test("web, grace: banner on every page, everything works; a paid agency has no banner", async () => {
    await h.seedBroker("owner");
    await endedAgo(1);
    const o = await signIn(h, "owner");
    for (const path of ["/app/units?lang=en", "/app/leads?lang=en", "/app/usage?lang=en"]) {
      const r = await o.agent.get(path);
      expect(r.status).toBe(200);
      expect(r.text).toContain('data-plan-banner="grace"');
      expect(r.text).toMatch(/grace period/);
    }
    expect((await o.agent.get("/app/units/new")).status).toBe(200);
    const lead = await o.agent.post("/app/leads/new").type("form").send({ _csrf: o.csrf, name: "Grace Lead", phone1: "01155550123", lawful_basis: "client_request" });
    expect(lead.status).not.toBe(402);
    await h.query("UPDATE agencies SET paid_until = NOW() + INTERVAL '5 days' WHERE id = $1", [h.AGENCY_A]);
    expect((await o.agent.get("/app/units?lang=en")).text).not.toContain("data-plan-banner");
  });

  test("the app's API: read-only and blocked refuse writes with 402; grace and paid pass", async () => {
    await h.seedBroker("owner");
    const o = h.BROKERS.owner;
    const code = await WebAuth.issueLoginCode(h.pool, { id: o.id, agency_id: o.agency_id });
    const token = (await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: o.phone, code })).body.token;
    const hdr = { Authorization: `Bearer ${token}` };
    const api = () => request(h.app.app);
    await endedAgo(1);
    expect((await api().post("/api/v1/leads").set(hdr).send({})).status).toBe(422); // grace: reaches validation
    await endedAgo(5);
    for (const [path, body] of [["/api/v1/leads", { name: "X", phone1: "01155550101" }], ["/api/v1/units", {}], ["/api/v1/units/AP-1/delete", {}], ["/api/v1/compare", { codes: ["A", "B"] }], ["/api/v1/search/voice", {}]]) {
      const r = await api().post(path).set(hdr).send(body);
      expect([path, r.status, r.body.error]).toEqual([path, 402, "plan_readonly"]);
      expect(typeof r.body.message).toBe("string");
    }
    expect((await api().get("/api/v1/units").set(hdr)).status).toBe(200);
    const plan = await api().get("/api/v1/plan").set(hdr);
    expect(plan.status).toBe(200);
    expect(plan.body.allowance.source).toBe("readonly");
    expect(plan.body.allowance.ladder).toMatchObject({ kind: "monthly" });
    expect((await api().post("/api/v1/plan/pay").set(hdr).send({ kind: "plan", plan: "solo", months: 1 })).status).toBe(200);
    await endedAgo(15);
    const blocked = await api().get("/api/v1/units").set(hdr);
    expect([blocked.status, blocked.body.error]).toEqual([402, "plan_blocked"]);
    expect((await api().get("/api/v1/plan").set(hdr)).status).toBe(200);
  });

  test("new share links, compare links and flyers are refused in read-only and blocked; old links keep working", async () => {
    const broker = { ...h.BROKERS.broker };
    const unit = await h.insertListing({ code: "LK-1" });
    await h.insertListing({ code: "LK-2" });
    await endedAgo(1);
    const old = await ShareLinks.createShareLink(h.pool, broker, unit); // made while the plan still ran (grace)
    for (const days of [5, 15]) {
      await endedAgo(days);
      await expect(ShareLinks.createShareLink(h.pool, broker, unit)).rejects.toMatchObject({ code: "PLAN_READONLY" });
      expect(await require("../../lib/compareLinks").createCompareLink(h.pool, broker, ["LK-1", "LK-2"])).toEqual({ error: "plan" });
      expect(await require("../../lib/flyer").flyerUrlFor(h.pool, broker, unit)).toEqual({ error: "plan" });
      // The link already sent still opens.
      const [slug] = (await h.query("SELECT slug FROM agencies WHERE id = $1", [h.AGENCY_A])).map((r) => r.slug);
      expect(await ShareLinks.resolveShareLink(h.pool, slug, unit.code, old.token)).toBeTruthy();
    }
    await endedAgo(1);
    await expect(ShareLinks.createShareLink(h.pool, broker, unit)).resolves.toHaveProperty("token");
  });

  test("bot: read-only answers read commands and local search, others get the payment link (a broker: ask your manager); blocked: pay link only", async () => {
    await endedAgo(5);
    const send = (who, t) => h.text(who, t);
    // A manager (admin) asking for something that writes or builds a link gets the payment link.
    for (const t of ["add", "delete AP-1", "price AP-1 9M", "flyer AP-1", "client AP-1", "lead 01155550101 interested", "ask how many units"]) {
      const out = textOf(await send("admin", t));
      expect([t, /\/app\/usage/.test(out) && /read-only|للقراءة/.test(out)]).toEqual([t, true]);
    }
    expect(textOf(await h.voice("admin"))).toMatch(/\/app\/usage/);
    expect(textOf(await h.photo("admin"))).toMatch(/\/app\/usage/);
    // Reads still answer.
    expect(textOf(await send("admin", "help"))).not.toMatch(/read-only|للقراءة بس/);
    expect(textOf(await send("admin", "stats"))).not.toMatch(/\/app\/usage/);
    // A broker never gets prices or the link.
    const b = textOf(await send("broker", "add"));
    expect(b).toMatch(/مديرك|manager/);
    expect(b).not.toMatch(/\/app\/usage/);
    await endedAgo(15);
    expect(textOf(await send("admin", "help"))).toMatch(/\/app\/usage/);
    expect(textOf(await send("admin", "stats"))).toMatch(/\/app\/usage/);
    expect(textOf(await send("broker", "help"))).not.toMatch(/\/app\/usage/);
  });

  test("bot: pure read-only rules and the once-a-day grace line", async () => {
    const t = (body) => ({ type: "text", text: { body } });
    for (const ok of ["help", "مساعدة", "stats", "export", "more", "عملائي", "شقة التجمع 3 غرف تحت 10 مليون", "AP-1"]) expect([ok, PlanGuard.botAllowsReadOnly(t(ok))]).toEqual([ok, true]);
    for (const no of ["add", "اضافة", "done", "delete AP-1", "sold AP-1", "edit AP-1", "price AP-1 9M", "flyer AP-1", "lead x", "ask x", "line one\nline two"]) expect([no, PlanGuard.botAllowsReadOnly(t(no))]).toEqual([no, false]);
    expect(PlanGuard.botAllowsReadOnly({ type: "audio" })).toBe(false);
    expect(PlanGuard.botAllowsReadOnly({ type: "image" })).toBe(false);
    expect(PlanGuard.botAllowsReadOnly({ type: "interactive", interactive: { button_reply: { id: "cmd:export" } } })).toBe(true);
    expect(PlanGuard.botAllowsReadOnly({ type: "interactive", interactive: { button_reply: { id: "DRAFT_SAVE" } } })).toBe(false);
    await endedAgo(1);
    const manager = { ...h.BROKERS.admin };
    const now = new Date();
    const first = await PlanGuard.bot(h.pool, manager, t("help"), "en", { now });
    expect(first.note).toMatch(/grace period until/);
    expect(await PlanGuard.bot(h.pool, manager, t("help"), "en", { now })).toBeNull();
    expect((await PlanGuard.bot(h.pool, manager, t("help"), "en", { now: new Date(now.getTime() + DAY) })).note).toBeTruthy();
    expect((await PlanGuard.bot(h.pool, h.BROKERS.broker, t("help"), "en", { now })).note).toMatch(/Ask your manager/);
    await h.query("UPDATE agencies SET paid_until = NOW() + INTERVAL '5 days' WHERE id = $1", [h.AGENCY_A]);
    expect(await PlanGuard.bot(h.pool, manager, t("help"), "en", { now: new Date(now.getTime() + 3 * DAY) })).toBeNull();
  });
});

describe("notifications along the ladder (owner and managers; brokers at read-only, blocked, restore; once per end date)", () => {
  const setEnd = (months = 1, trial = false) =>
    h.query("UPDATE agencies SET pilot = false, plan = $4, paid_until = $2, trial_ends_at = $3 WHERE id = $1", [h.AGENCY_A, trial ? null : E.toISOString(), trial ? E.toISOString() : null, trial ? "trial" : "solo"]).then(async () => {
      if (months >= 6) await h.query("INSERT INTO payments (agency_id, kind, plan, months, amount_egp, reference, status, confirmed_at) VALUES ($1, 'plan', 'solo', $2, 1075, 'WH-NOTICE', 'confirmed', '2026-01-01')", [h.AGENCY_A, months]);
    });
  const keys = async () => (await h.query("SELECT dedupe_key, broker_id FROM notifications WHERE dedupe_key LIKE 'plan_ladder:%' AND agency_id = $1 ORDER BY created_at, id", [h.AGENCY_A])).map((r) => ({ id: r.dedupe_key.split(":").pop(), broker: r.broker_id }));
  const ids = async () => [...new Set((await keys()).map((k) => k.id))];
  const run = (now) => BillingNotices.remindLapsed(h.pool, { now });
  const manager = () => h.BROKERS.owner.id;

  test("monthly: T0 grace, day before read-only, read-only, 3 days before blocked, last day, blocked; deduped", async () => {
    await h.seedBroker("owner");
    await setEnd(1);
    expect((await run(at(-1))).sent).toBe(0);
    const seen = [];
    for (const [day, id] of [[0, "grace"], [2, "ro_eve"], [3, "ro_start"], [7, "block_3"], [9, "block_1"], [10, "blocked"]]) {
      await run(at(day + 0.01));
      seen.push(id);
      expect(await ids()).toEqual(seen);
    }
    const before = (await keys()).length;
    await run(at(10.5));
    await run(at(10.6));
    expect((await keys()).length).toBe(before); // once per step and end date
    // Managers (owner, admin) hear every step; brokers only read-only start and blocked.
    const k = await keys();
    expect(k.filter((x) => x.broker === manager()).map((x) => x.id)).toEqual(seen);
    const brokerSteps = [...new Set(k.filter((x) => x.broker === h.BROKERS.broker.id).map((x) => x.id))];
    expect(brokerSteps.sort()).toEqual(["blocked", "ro_start"]);
    const [n] = await h.query("SELECT title FROM notifications WHERE dedupe_key LIKE '%:ro_start' AND broker_id = $1", [h.BROKERS.broker.id]);
    expect(n.title).not.toMatch(/EGP|ج\.م|\/app\/usage/);
    expect(n.title).toMatch(/مديرك|manager/);
  });

  test("a job that ran late sends only the tightest step still due", async () => {
    await h.seedBroker("owner");
    await setEnd(1);
    await run(at(9.5)); // nothing ran since the end
    expect(await ids()).toEqual(["block_1"]);
    await run(at(10.2));
    expect(await ids()).toEqual(["block_1", "blocked"]);
  });

  test("6/12 month plans on their shifted timeline: T0, day before read-only, read-only, 3 days before blocked, last day, blocked", async () => {
    await h.seedBroker("owner");
    await setEnd(12);
    const seen = [];
    for (const [day, id] of [[0, "grace"], [6, "ro_eve"], [7, "ro_start"], [18, "block_3"], [20, "block_1"], [21, "blocked"]]) {
      await run(at(day + 0.01));
      seen.push(id);
      expect(await ids()).toEqual(seen);
    }
    expect((await keys()).some((k) => k.id === "ro_start" && k.broker === h.BROKERS.broker.id)).toBe(true);
  });

  test("trial: no grace notice; the day after it ended read-only, 3 days before blocked, last day, blocked", async () => {
    await h.seedBroker("owner");
    await setEnd(1, true);
    await run(at(0.5));
    expect(await ids()).toEqual([]);
    const seen = [];
    for (const [day, id] of [[1, "ro_notice"], [4, "block_3"], [6, "block_1"], [7, "blocked"]]) {
      await run(at(day + 0.01));
      seen.push(id);
      expect(await ids()).toEqual(seen);
    }
    expect([...new Set((await keys()).filter((k) => k.broker === h.BROKERS.broker.id).map((k) => k.id))]).toEqual(["blocked"]);
  });

  test("an extended grace is announced again (the key carries the end dates); a new period end starts afresh", async () => {
    await h.seedBroker("owner");
    await setEnd(1);
    await run(at(0.5));
    expect(await ids()).toEqual(["grace"]);
    await h.query("UPDATE agencies SET grace_extra_until = $2 WHERE id = $1", [h.AGENCY_A, at(8).toISOString()]);
    await run(at(0.6));
    // The owner (a manager; the CRM admin gets no agency alerts) heard the grace notice twice: once per grace end.
    expect((await keys()).filter((k) => k.id === "grace" && k.broker === manager()).length).toBe(2);
  });

  test("restore: paying in grace, read-only or blocked tells owner, managers and brokers once; paying early tells no one", async () => {
    await h.seedBroker("owner");
    await endedAgo(5);
    const p = (await Billing.requestPayment(h.pool, h.BROKERS.owner, { kind: "plan", plan: "solo", months: 1 })).payment;
    const r = await Billing.confirmPayment(h.pool, p.id);
    await BillingNotices.paymentConfirmed(h.pool, r);
    await BillingNotices.paymentConfirmed(h.pool, r);
    const rows = await h.query("SELECT broker_id FROM notifications WHERE dedupe_key = $1", [`plan_restored:${p.id}`]);
    const who = new Set(rows.map((x) => x.broker_id));
    expect(rows.length).toBe(who.size);
    expect(who.has(h.BROKERS.owner.id)).toBe(true);
    expect(who.has(h.BROKERS.broker.id)).toBe(true);
    const p2 = (await Billing.requestPayment(h.pool, h.BROKERS.owner, { kind: "plan", plan: "solo", months: 1 })).payment;
    const r2 = await Billing.confirmPayment(h.pool, p2.id); // the plan runs now: queued, no restore
    await BillingNotices.paymentConfirmed(h.pool, r2);
    expect(await h.query("SELECT 1 FROM notifications WHERE dedupe_key = $1", [`plan_restored:${p2.id}`])).toEqual([]);
  });

  test("the hourly job runs the lapsed notices too", async () => {
    await h.seedBroker("owner");
    await setEnd(1);
    const job = BillingNotices.reminderJob();
    const out = await job.run({ pool: h.pool, now: at(0.5) });
    expect(out.counts.lapsed).toBeGreaterThan(0);
  });
});

describe("the owner's Plans form edits the per-period prices", () => {
  const body = async (csrf, over = {}) => {
    const out = { _csrf: csrf };
    for (const p of await Credits.plans(h.pool)) {
      Object.assign(out, { [`p_${p.id}_name_ar`]: p.name_ar, [`p_${p.id}_name_en`]: p.name_en, [`p_${p.id}_price`]: p.price_egp, [`p_${p.id}_seats`]: p.seats, [`p_${p.id}_units`]: p.units, [`p_${p.id}_credits`]: p.credits });
      if (p.active) out[`p_${p.id}_active`] = "on";
    }
    return { ...out, ...over };
  };

  test("the form shows the table; saving changes what is purchasable; a new plan with prices is purchasable; bad input is refused", async () => {
    const a = await signIn(h, "admin");
    const page = await a.agent.get("/app/owner?lang=en");
    expect(page.text).toContain('data-plan-prices="solo"');
    expect(page.text).toContain("1:199, 6:1075, 12:1990");
    expect(page.text).toContain('name="grace_ai_pct"');
    // Edit Solo: a new monthly price, no 12 month plan any more.
    let res = await a.agent.post("/app/owner/credit-plans").type("form").send(await body(a.csrf, { p_solo_prices: "1:250, 6:1300" }));
    expect(res.status).toBe(200);
    expect(Billing.priceOf({ kind: "plan", plan: "solo", months: 1 })).toBe(250);
    expect(Billing.priceOf({ kind: "plan", plan: "solo", months: 6 })).toBe(1300);
    expect(Billing.priceOf({ kind: "plan", plan: "solo", months: 12 })).toBeNull();
    expect((await h.query("SELECT prices FROM credit_plans WHERE id = 'solo'"))[0].prices).toEqual({ 1: 250, 6: 1300 });
    // A form without the field leaves the table alone.
    res = await a.agent.post("/app/owner/credit-plans").type("form").send(await body(a.csrf));
    expect(res.status).toBe(200);
    expect(Billing.priceOf({ kind: "plan", plan: "solo", months: 1 })).toBe(250);
    // A new plan with prices can be bought.
    res = await a.agent.post("/app/owner/credit-plans").type("form").send(await body(a.csrf, { new_id: "mini", new_name_ar: "ميني", new_name_en: "Mini", new_price: "99", new_seats: "2", new_units: "200", new_credits: "100", new_prices: "1:99, 12:990" }));
    expect(res.status).toBe(200);
    expect(Billing.priceOf({ kind: "plan", plan: "mini", months: 12 })).toBe(990);
    expect(Plans.PLANS.some((p) => p.id === "mini")).toBe(true);
    // A plan with no prices is not purchasable.
    res = await a.agent.post("/app/owner/credit-plans").type("form").send(await body(a.csrf, { p_mini_prices: "" }));
    expect(res.status).toBe(200);
    expect(Plans.periodsOf(Plans.planById("mini"))).toEqual([]);
    expect(Billing.priceOf({ kind: "plan", plan: "mini", months: 1 })).toBeNull();
    // Bad input.
    for (const bad of ["1:abc", "0:100", "1:0", "x", "1-100"]) {
      res = await a.agent.post("/app/owner/credit-plans").type("form").send(await body(a.csrf, { p_solo_prices: bad }));
      expect([bad, res.status]).toEqual([bad, 400]);
    }
    expect(Credits.parsePrices("1:199, 6 = 1075\n12:1990")).toEqual({ 1: 199, 6: 1075, 12: 1990 });
    expect(Credits.pricesText({ 12: 1990, 1: 199 })).toBe("1:199, 12:1990");
  });

  test("grace_ai_pct is saved from the Plans page (0 to 100) through app_settings", async () => {
    const a = await signIn(h, "admin");
    expect(await Billing.graceAiPct(h.pool)).toBe(15);
    expect((await a.agent.post("/app/owner/grace-ai").type("form").send({ _csrf: a.csrf, grace_ai_pct: "30" })).status).toBe(200);
    expect(await Billing.getSetting(h.pool, "grace_ai_pct", null)).toBe(30);
    expect(await Billing.graceAiPct(h.pool)).toBe(30);
    for (const bad of ["101", "-1", "abc", ""]) expect((await a.agent.post("/app/owner/grace-ai").type("form").send({ _csrf: a.csrf, grace_ai_pct: bad })).status).toBe(400);
    expect(await Billing.graceAiPct(h.pool)).toBe(30);
  });
});
