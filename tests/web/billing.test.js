// tests/web/billing.test.js — Phase 2 step 4: plans, allowances, manual payments and self sign-up.
// effectivePlan (pilot → Office free, paid, trial, the expiry ladder, Free for an agency with no history); monthly text/voice allowance counted from operation_logs and
// enforced before an AI call (PLAN_QUOTA_EXCEEDED, credit bundles add their credits); seats cap invites; a manager announces a
// payment (amount + reference + where to pay), the owner confirms and the period is extended; sign-up switch, waiting
// request, approve (trial + start link) and reject; reminders (trial 3 and 1 days, monthly 7/3/1, 6+ months 30/14/7/3/1), once each;
// the explicit price table per plan and period (migration 128).
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const { resetConfig } = require("../../config");
const Billing = require("../../services/billing");
const BillingNotices = require("../../services/billingNotices");
const Signup = require("../../services/signup");
const Plans = require("../../domain/plans");
const Credits = require("../../services/credits");

jest.setTimeout(90000);

let h;
beforeAll(() => {
  process.env.TELEGRAM_BOT_USERNAME = "Wehdat_Hub_bot";
  resetConfig();
});
beforeEach(async () => {
  h = await createHarness();
  process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
  resetConfig();
});
afterAll(async () => {
  delete process.env.TELEGRAM_BOT_USERNAME;
  delete process.env.OWNER_BROKER_IDS;
  resetConfig();
  await closeHarness();
});

const DAY = 86400000;
const NOW = new Date();
const useAi = async (n, { audio = false, agency = h.AGENCY_A } = {}) => {
  for (let i = 0; i < n; i++) {
    await h.query(
      `INSERT INTO operation_logs (agency_id, broker_id, operation_type, status, model_used, gemini_ms, metadata, created_at)
       VALUES ($1, $2, 'listing_extraction', 'success', 'gemini-x', 10, $3, NOW())`,
      [agency, h.BROKERS.broker.id, JSON.stringify(audio ? { media: "audio" } : {})]
    );
  }
};
const notPilot = (extra = "") => h.query(`UPDATE agencies SET pilot = false ${extra} WHERE id = $1`, [h.AGENCY_A]);

test("only the platform owner controls the independent payment channels", async () => {
  const admin = await signIn(h, "admin");
  await h.query("UPDATE brokers SET role = 'owner' WHERE id = $1", [h.BROKERS.broker.id]);
  const owner = await signIn(h, "broker");
  const path = "/app/owner/payment-channels";
  expect((await owner.agent.post(path).type("form").send({ _csrf: owner.csrf, sms: "1" })).status).toBe(404);
  expect(await Billing.paymentChannels(h.pool)).toEqual({ sms: false, telegram: false });
  expect((await admin.agent.post(path).type("form").send({ _csrf: admin.csrf, sms: "1" })).status).toBe(303);
  expect(await Billing.paymentChannels(h.pool)).toEqual({ sms: true, telegram: false });
  expect((await admin.agent.post(path).type("form").send({ _csrf: admin.csrf, telegram: "1" })).status).toBe(303);
  expect(await Billing.paymentChannels(h.pool)).toEqual({ sms: false, telegram: true });
});

test("effectivePlan: pilot is Office for free, then paid, trial, and Free when nothing is running", () => {
  const future = new Date(NOW.getTime() + DAY);
  const past = new Date(NOW.getTime() - DAY);
  expect(Billing.effectivePlan({ pilot: true, plan: "solo" }, NOW)).toMatchObject({ source: "pilot", plan: { id: "office" } });
  expect(Billing.effectivePlan({ plan: "agency", paid_until: future }, NOW)).toMatchObject({ source: "paid", plan: { id: "agency" } });
  expect(Billing.effectivePlan({ plan: "agency", paid_until: past, trial_ends_at: future }, NOW)).toMatchObject({ source: "trial", plan: { id: "trial", seats: 1, units: 50, credits: 80 } });
  // Once a trial or paid period ended there is no Free step any more: grace, read-only, blocked (tests/web/plan-ladder.test.js).
  expect(Billing.effectivePlan({ plan: "agency", paid_until: past, trial_ends_at: past }, NOW)).toMatchObject({ source: "grace", plan: { id: "agency" } });
  // An agency that never had a trial or a paid period keeps the Free plan.
  expect(Billing.effectivePlan({ plan: "free" }, NOW)).toMatchObject({ source: "free", plan: { id: "free" } });
});

test("existing agencies are pilots; the monthly credits count a text request as 1 and a voice note as 3 and block at the pool", async () => {
  expect((await h.query("SELECT pilot FROM agencies WHERE id = $1", [h.AGENCY_A]))[0].pilot).toBe(true);
  await notPilot();
  await useAi(76);
  await useAi(1, { audio: true });
  expect(await Credits.usedThisMonth(h.pool, h.AGENCY_A)).toBe(79);
  expect(await Credits.poolFor(h.pool, h.AGENCY_A, "free")).toMatchObject({ total: 80 });
  await expect(Billing.checkAllowance(h.pool, h.AGENCY_A)).resolves.toMatchObject({ used: 79, limit: 80 });
  await useAi(1);
  await expect(Billing.checkAllowance(h.pool, h.AGENCY_A)).rejects.toMatchObject({ code: "PLAN_QUOTA_EXCEEDED", kind: "credits", limit: 80, used: 80 });
  // Another agency's use never counts here.
  expect(await Credits.usedThisMonth(h.pool, h.AGENCY_B)).toBe(0);
});

test("credits are charged once per action: a search's second row is free, a page read charges the page credits, reused or not", async () => {
  await h.query("INSERT INTO operation_logs (agency_id, broker_id, operation_type, status, model_used, gemini_ms) VALUES ($1, $2, 'search_parse', 'success', 'gemini-x', 10), ($1, $2, 'search_query', 'success', 'gemini-x', 10), ($1, $2, 'price_list_read', 'success', 'gemini-x', 10)", [h.AGENCY_A, h.BROKERS.broker.id]);
  expect(await Credits.usedThisMonth(h.pool, h.AGENCY_A)).toBe(1);
  await h.query("INSERT INTO price_read_log (agency_id, fingerprint, reused) VALUES ($1, 'f1', false), ($1, 'f2', true)", [h.AGENCY_A]);
  expect(await Credits.usedThisMonth(h.pool, h.AGENCY_A)).toBe(21);
});

test("the AI gateway checks the plan before calling and records voice notes as audio", async () => {
  const AI = jest.requireActual("../../lib/ai");
  AI._setClientForTests({ models: { generateContent: async () => ({ text: "ok", usageMetadata: {} }) } });
  try {
    const broker = { id: h.BROKERS.broker.id, agency_id: h.AGENCY_A };
    const audio = [{ parts: [{ inlineData: { mimeType: "audio/ogg", data: "AA" } }, { text: "transcribe" }] }];
    await AI.generateWithCascade({ contents: audio, operationType: "listing_extraction", ctx: { pool: h.pool, broker } });
    await new Promise((r) => setTimeout(r, 50));
    const [row] = await h.query("SELECT metadata->>'media' AS media FROM operation_logs WHERE operation_type = 'listing_extraction'");
    expect(row.media).toBe("audio");
    await notPilot();
    await useAi(80);
    await expect(AI.generateWithCascade({ contents: "hello", operationType: "listing_extraction", ctx: { pool: h.pool, broker } })).rejects.toMatchObject({ code: "PLAN_QUOTA_EXCEEDED" });
  } finally {
    AI._setClientForTests(null);
  }
});

test("seats: on the Free plan (1 seat) a manager can't add another broker; nobody is removed", async () => {
  await notPilot();
  const a = await signIn(h, "admin");
  const res = await a.agent.post("/app/team/invite").type("form").send({ _csrf: a.csrf, name: "Nour", phone: "01099887766", role: "broker" });
  expect(res.status).toBe(400);
  expect(res.text).toMatch(/seat|مقاعد/i);
  expect(await h.query("SELECT 1 FROM brokers WHERE phone_normalized = '201099887766'")).toEqual([]);
  expect((await h.query("SELECT count(*)::int AS n FROM brokers WHERE agency_id = $1 AND is_active", [h.AGENCY_A]))[0].n).toBeGreaterThan(1);
});

test("a manager announces a payment, the owner confirms it and the paid period starts; brokers can't pay", async () => {
  await Billing.savePayTo(h.pool, { instapay: "wehdat@instapay", bank: "" });
  await h.seedBroker("owner"); // plan payments are the agency owner's
  const a = await signIn(h, "admin"); // the CRM owner (OWNER_BROKER_IDS) for /app/owner
  const o = await signIn(h, "owner");
  const page = await o.agent.get("/app/usage?lang=en");
  expect(page.status).toBe(200);
  expect(page.text).toContain('data-source="pilot"');
  const pay = await o.agent.post("/app/plan/pay").type("form").send({ _csrf: o.csrf, kind: "plan", plan: "agency", months: "6" });
  expect(pay.status).toBe(200);
  const ref = (pay.text.match(/data-payment="(WH-[A-Z0-9]{6})"/) || [])[1];
  expect(ref).toBeDefined();
  expect(pay.text).toContain("16,146 EGP");
  expect(pay.text).toContain("wehdat@instapay");
  expect((await o.agent.post("/app/plan/pay").type("form").send({ _csrf: o.csrf, kind: "plan", plan: "gold", months: "6" })).status).toBe(400);
  // A period the plan doesn't offer (Agency has no monthly or 3-month price) is refused.
  expect((await o.agent.post("/app/plan/pay").type("form").send({ _csrf: o.csrf, kind: "plan", plan: "agency", months: "1" })).status).toBe(400);
  expect((await o.agent.post("/app/plan/pay").type("form").send({ _csrf: o.csrf, kind: "plan", plan: "solo", months: "3" })).status).toBe(400);

  const b = await signIn(h, "broker");
  expect((await b.agent.get("/app/usage")).status).toBe(200);
  expect((await b.agent.post("/app/plan/pay").type("form").send({ _csrf: b.csrf, kind: "plan", plan: "solo", months: "1" })).status).toBe(403);

  const owner = await a.agent.get("/app/owner?lang=en");
  expect(owner.text).toContain(`data-payment="${ref}"`);
  const [p] = await h.query("SELECT id FROM payments WHERE reference = $1", [ref]);
  expect((await a.agent.post(`/app/owner/payments/${p.id}/confirm`).type("form").send({ _csrf: a.csrf })).status).toBe(200);
  const [agency] = await h.query("SELECT plan, pilot, paid_until FROM agencies WHERE id = $1", [h.AGENCY_A]);
  expect(agency).toMatchObject({ plan: "agency", pilot: false });
  const days = (new Date(agency.paid_until) - Date.now()) / DAY;
  expect(days).toBeGreaterThan(178);
  expect(days).toBeLessThan(186);
  expect((await a.agent.post(`/app/owner/payments/${p.id}/confirm`).type("form").send({ _csrf: a.csrf })).status).toBe(400);
  expect(await h.query("SELECT 1 FROM notifications WHERE kind = 'manager_alert' AND title LIKE $1", [`%${ref}%`])).not.toEqual([]);
  // A credit bundle adds its credits this month.
  await o.agent.post("/app/plan/pay").type("form").send({ _csrf: o.csrf, kind: "credit_bundle", bundle: "medium" });
  const [vp] = await h.query("SELECT id, amount_egp FROM payments WHERE kind = 'credit_bundle'");
  expect(Number(vp.amount_egp)).toBe(229);
  await Billing.confirmPayment(h.pool, vp.id);
  expect((await Billing.allowance(h.pool, h.AGENCY_A)).credits).toMatchObject({ plan: 10000, bundles: 500, limit: 10500 });
  // A manager asks for more credits; the owner approves and the grant joins this month's pool.
  expect((await o.agent.post("/app/plan/credit-request").type("form").send({ _csrf: o.csrf, credits: "300", note: "busy month" })).status).toBe(200);
  const [rq] = await h.query("SELECT id, status FROM credit_requests");
  expect(rq.status).toBe("pending");
  expect(await Credits.decideRequest(h.pool, rq.id, { approve: true })).toMatchObject({ ok: true });
  expect((await Billing.allowance(h.pool, h.AGENCY_A)).credits).toMatchObject({ grants: 300, limit: 10800 });
  // Owner controls are 404 for everyone else.
  expect((await b.agent.post(`/app/owner/payments/${p.id}/cancel`).type("form").send({ _csrf: b.csrf })).status).toBe(404);
});

test("the plan lives on the Usage page: /app/plan redirects there, managers and the owner see it, brokers do not", async () => {
  await h.seedBroker("owner");
  const o = await signIn(h, "owner");
  const old = await o.agent.get("/app/plan").redirects(0);
  expect(old.status).toBe(303);
  expect(old.headers.location).toBe("/app/usage#plan");
  const page = await o.agent.get("/app/usage?lang=en");
  expect(page.text).toContain('id="plan"');
  expect(page.text).toContain("data-credit-table");
  const b = await signIn(h, "broker");
  expect((await b.agent.get("/app/usage?lang=en")).text).not.toContain('id="plan"');
});

test("sign-up: closed by default; open → the web form starts a Telegram-verified self-serve trial (tests/web/trial-signup.test.js); the legacy owner approval of already-pending requests still works", async () => {
  const anon = request.agent(h.app.app);
  expect((await anon.get("/app/signup?lang=en")).text).toMatch(/closed/i);
  expect((await anon.post("/app/signup").type("form").send({ agency: "X", name: "Y", phone: "01055556666", consent: "1" })).status).toBe(403);

  const a = await signIn(h, "admin");
  await a.agent.post("/app/owner/signup").type("form").send({ _csrf: a.csrf, open: "1" });
  expect(await Signup.isOpen(h.pool)).toBe(true);
  expect((await request(h.app.app).get("/?lang=en")).text).toContain("/app/signup");
  expect((await anon.post("/app/signup").type("form").send({ agency: "Delta Homes", name: "Omar", phone: "01055556666" })).status).toBe(400);
  expect((await anon.post("/app/signup").type("form").send({ agency: "Taken", name: "T", phone: `0${h.BROKERS.rival.phone.slice(2)}`, consent: "1" })).status).toBe(400);
  const started = await anon.post("/app/signup").type("form").send({ agency: "Delta Homes", name: "Omar", phone: "01055556666", consent: "1" });
  expect(started.status).toBe(200);
  expect(started.text).toMatch(/https:\/\/t\.me\/Wehdat_Hub_bot\?start=su_/);
  expect(await h.query("SELECT 1 FROM agencies WHERE name = 'Delta Homes'")).toEqual([]); // nothing is created until the Telegram step
  // Legacy: requests already waiting for approval (Signup.submit) are still approved or rejected from /app/owner.
  expect((await Signup.submit(h.pool, { agency: "Delta Homes", name: "Omar", phone: "01055556666", lang: "en" })).ok).toBe(true);
  const [ag] = await h.query("SELECT id, approval, pilot FROM agencies WHERE name = 'Delta Homes'");
  expect(ag).toMatchObject({ approval: "pending", pilot: false });
  expect((await h.query("SELECT is_active, role FROM brokers WHERE agency_id = $1", [ag.id]))[0]).toEqual({ is_active: false, role: "owner" });

  const approved = await a.agent.post(`/app/owner/signups/${ag.id}/approve`).type("form").send({ _csrf: a.csrf });
  expect(approved.status).toBe(200);
  expect(approved.text).toMatch(/https:\/\/t\.me\/Wehdat_Hub_bot\?start=[A-Za-z0-9_-]+/);
  expect(approved.text).toMatch(/https:\/\/wa\.me\/201055556666\?text=/);
  const [after] = await h.query("SELECT approval, plan, trial_ends_at FROM agencies WHERE id = $1", [ag.id]);
  expect(after).toMatchObject({ approval: "approved", plan: "trial" });
  expect(Math.round((new Date(after.trial_ends_at) - Date.now()) / DAY)).toBe(Plans.TRIAL.days);
  expect(await Billing.allowance(h.pool, ag.id)).toMatchObject({ source: "trial", seats: { limit: 1 }, units: { limit: 50 }, credits: { limit: 80 } });
  expect((await h.query("SELECT is_active FROM brokers WHERE agency_id = $1", [ag.id]))[0].is_active).toBe(true);

  await Signup.submit(h.pool, { agency: "Spam Co", name: "S", phone: "01077778888", lang: "en" });
  const [spam] = await h.query("SELECT id FROM agencies WHERE name = 'Spam Co'");
  await a.agent.post(`/app/owner/signups/${spam.id}/reject`).type("form").send({ _csrf: a.csrf });
  expect((await h.query("SELECT approval FROM agencies WHERE id = $1", [spam.id]))[0].approval).toBe("rejected");
  expect((await h.query("SELECT is_active FROM brokers WHERE agency_id = $1", [spam.id]))[0].is_active).toBe(false);
});

const setEnd = (col, days) => h.query("UPDATE agencies SET pilot = false, paid_until = CASE WHEN $3::text = 'paid_until' THEN $2::timestamptz END, trial_ends_at = CASE WHEN $3::text = 'trial_ends_at' THEN $2::timestamptz END WHERE id = $1", [h.AGENCY_A, new Date(Date.now() + days * DAY).toISOString(), col]);
const reminderKeys = async () => (await h.query("SELECT dedupe_key FROM notifications WHERE dedupe_key LIKE 'plan_end:%' AND agency_id = $1", [h.AGENCY_A])).map((r) => r.dedupe_key.split(":").pop());

test("trial: owner and managers hear 3 days (day 11) and 1 day (day 13) before it ends, once each, with the neutral data line", async () => {
  await h.seedBroker("owner");
  await setEnd("trial_ends_at", 4);
  expect((await BillingNotices.remindEnding(h.pool)).sent).toBe(0);
  await setEnd("trial_ends_at", 2.9);
  const first = (await BillingNotices.remindEnding(h.pool)).sent;
  expect(first).toBeGreaterThan(0);
  await BillingNotices.remindEnding(h.pool);
  const rows = await h.query("SELECT broker_id, body FROM notifications WHERE dedupe_key LIKE 'plan_end:%' AND agency_id = $1", [h.AGENCY_A]);
  expect(new Set(rows.map((r) => r.broker_id)).size).toBe(rows.length);
  expect(rows.map((r) => r.broker_id)).toContain(h.BROKERS.owner.id);
  expect(new Set(await reminderKeys())).toEqual(new Set(["3"]));
  for (const r of rows) {
    expect(r.body).not.toMatch(/Free plan|الباقة المجانية/);
    expect(r.body).toMatch(/never deleted|مش بتتمسح/);
  }
  await setEnd("trial_ends_at", 0.9);
  await BillingNotices.remindEnding(h.pool);
  expect(new Set(await reminderKeys())).toEqual(new Set(["3", "1"]));
  expect((await reminderKeys()).length).toBe(rows.length * 2);
});

test("a monthly paid plan is reminded 7, 3 and 1 days before it ends", async () => {
  await h.seedBroker("owner"); // the CRM owner (admin here) gets no agency alerts
  await setEnd("paid_until", 8);
  expect((await BillingNotices.remindEnding(h.pool)).sent).toBe(0);
  for (const [left, key] of [[6.9, "7"], [2.9, "3"], [0.9, "1"]]) {
    await setEnd("paid_until", left);
    await BillingNotices.remindEnding(h.pool);
    expect(new Set(await reminderKeys()).has(key)).toBe(true);
  }
  expect(new Set(await reminderKeys())).toEqual(new Set(["7", "3", "1"]));
  expect(Billing.REMINDER_DAYS.monthly).toEqual([7, 3, 1]);
});

test("a plan last paid for 6 or 12 months is reminded 30, 14, 7, 3 and 1 days before it ends", async () => {
  await h.seedBroker("owner");
  await h.query("INSERT INTO payments (agency_id, kind, plan, months, amount_egp, reference, status, confirmed_at) VALUES ($1, 'plan', 'solo', 6, 1075, 'WH-LONG01', 'confirmed', NOW())", [h.AGENCY_A]);
  await setEnd("paid_until", 31);
  expect((await BillingNotices.remindEnding(h.pool)).sent).toBe(0);
  for (const [left, key] of [[29.5, "30"], [13.5, "14"], [6.5, "7"], [2.5, "3"], [0.5, "1"]]) {
    await setEnd("paid_until", left);
    await BillingNotices.remindEnding(h.pool);
    expect(new Set(await reminderKeys()).has(key)).toBe(true);
  }
  expect(new Set(await reminderKeys())).toEqual(new Set(["30", "14", "7", "3", "1"]));
  // A later monthly payment puts the agency back on the monthly ladder: 14 days left is not a reminder day any more.
  await h.query("INSERT INTO payments (agency_id, kind, plan, months, amount_egp, reference, status, confirmed_at) VALUES ($1, 'plan', 'solo', 1, 199, 'WH-MONTH1', 'confirmed', NOW() + INTERVAL '1 minute')", [h.AGENCY_A]);
  await h.query("DELETE FROM notifications WHERE dedupe_key LIKE 'plan_end:%'");
  await setEnd("paid_until", 14);
  expect((await BillingNotices.remindEnding(h.pool)).sent).toBe(0);
});

test("period prices come from the explicit table: priceOf, MONTHS and the plan page's offered periods", async () => {
  expect(Billing.MONTHS).toEqual([1, 6, 12]);
  const price = (plan, months) => Billing.priceOf({ kind: "plan", plan, months });
  expect([1, 6, 12].map((m) => price("solo", m))).toEqual([199, 1075, 1990]);
  expect([1, 6, 12].map((m) => price("team", m))).toEqual([599, 3235, 5990]);
  expect([1, 6, 12].map((m) => price("office", m))).toEqual([1790, 9666, 17900]);
  expect([1, 6, 12].map((m) => price("agency", m))).toEqual([null, 16146, 29900]);
  expect(price("solo", 3)).toBeNull();
  expect(price("enterprise", 12)).toBeNull();
  expect(price("trial", 1)).toBeNull();
  expect(Billing.priceOf({ kind: "credit_bundle", bundle: "agency" })).toBe(899);
  await h.seedBroker("owner");
  const o = await signIn(h, "owner");
  const page = (await o.agent.get("/app/usage?lang=en")).text;
  const card = (id) => page.match(new RegExp(`data-plan-card="${id}"[^]*?</fieldset>`))[0];
  expect([...card("solo").matchAll(/data-period="(\d+)"/g)].map((m) => m[1])).toEqual(["1", "6", "12"]);
  expect([...card("agency").matchAll(/data-period="(\d+)"/g)].map((m) => m[1])).toEqual(["6", "12"]);
  expect(card("solo")).toContain("~179/mo");
  expect(card("solo")).toContain("~166/mo");
  expect(card("agency")).toContain("~2,691/mo");
  expect(page).not.toContain('data-plan-card="trial"');
  expect(page).not.toContain('data-plan-card="enterprise"');
  // One choice posts plan and period together.
  const pay = await o.agent.post("/app/plan/pay").type("form").send({ _csrf: o.csrf, kind: "plan", choice: "team:12" });
  expect(pay.text).toContain("5,990 EGP");
});

test("the trial plan is 1 seat, 50 units, 80 credits, price 0 and is not purchasable", async () => {
  const t = Plans.planById("trial");
  expect(t).toMatchObject({ seats: 1, units: 50, credits: 80, priceEgp: 0 });
  expect(Plans.TRIAL).toMatchObject({ plan: "trial", days: 14 });
  expect(Billing.priceOf({ kind: "plan", plan: "trial", months: 1 })).toBeNull();
  expect(Plans.PLANS.some((p) => p.id === "trial")).toBe(false);
  // A pilot created by the owner stays on Office; a trial created by the owner is on the trial plan.
  expect(Billing.effectivePlan({ pilot: true, plan: "office" }, NOW).plan.id).toBe("office");
});

test("the owner extends a trial by 7 or 14 days, also after it ended; pilots and other amounts are refused", async () => {
  const ended = new Date(Date.now() - 2 * DAY);
  await h.query("UPDATE agencies SET pilot = false, trial_ends_at = $2 WHERE id = $1", [h.AGENCY_B, ended.toISOString()]);
  const a = await signIn(h, "admin");
  const page = await a.agent.get("/app/owner");
  expect(page.text).toMatch(new RegExp(`data-trial-agency="${h.AGENCY_B}"`));
  expect(page.text).not.toMatch(new RegExp(`data-trial-agency="${h.AGENCY_A}"`));
  const r = await a.agent.post(`/app/owner/trials/${h.AGENCY_B}/extend`).type("form").send({ _csrf: a.csrf, days: "7" });
  expect(r.status).toBe(200);
  const [b] = await h.query("SELECT trial_ends_at FROM agencies WHERE id = $1", [h.AGENCY_B]);
  // From now (the trial had ended), not from the old end.
  expect(Math.round((new Date(b.trial_ends_at) - Date.now()) / DAY)).toBe(7);
  expect((await Billing.allowance(h.pool, h.AGENCY_B)).source).toBe("trial");
  expect((await a.agent.post(`/app/owner/trials/${h.AGENCY_B}/extend`).type("form").send({ _csrf: a.csrf, days: "30" })).status).toBe(400);
  expect((await a.agent.post(`/app/owner/trials/${h.AGENCY_A}/extend`).type("form").send({ _csrf: a.csrf, days: "7" })).status).toBe(400);
  const broker = await signIn(h, "broker");
  expect((await broker.agent.post(`/app/owner/trials/${h.AGENCY_B}/extend`).type("form").send({ _csrf: broker.csrf, days: "7" })).status).toBe(404);
});
