"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const { resetConfig } = require("../../config");
const Signup = require("../../services/signup");
const TrialSignup = require("../../services/trialSignup");

jest.setTimeout(90000);

let h;
beforeAll(() => {
  process.env.TELEGRAM_BOT_USERNAME = "Wehdat_Hub_bot";
  process.env.TELEGRAM_BOT_TOKEN = "123:test";
  process.env.WHATSAPP_BUSINESS_PHONE = "201099990000";
  resetConfig();
});

beforeEach(async () => {
  h = await createHarness();
  await Signup.setOpen(h.pool, true);
});

afterEach(async () => {
  await closeHarness(h);
});

describe("Onboarding progress on GET /api/v1/me", () => {
  test("returns hasUnit, hasSharedLink, telegramConnected for solo broker and updates when unit added", async () => {
    const started = await TrialSignup.start(
      h.pool,
      { agency: "Nora", name: "Nora", phone: "01077778888", lang: "ar", tier: "solo", channel: "whatsapp" },
      { waNumber: "201099990000" }
    );
    const verified = await TrialSignup.verifyWhatsApp(h.pool, started.token, "201077778888");
    const authRes = await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: "01077778888", code: verified.loginCode });
    const token = authRes.body.token;

    const me1 = await request(h.app.app).get("/api/v1/me").set("Authorization", `Bearer ${token}`);
    expect(me1.status).toBe(200);
    expect(me1.body.onboarding).toEqual({ hasUnit: false, hasSharedLink: false, telegramConnected: false, hasAsked: false });

    const home1 = await request(h.app.app).get("/api/v1/today/home").set("Authorization", `Bearer ${token}`);
    expect(home1.status).toBe(200);
    expect(home1.body.onboarding).toEqual({ hasUnit: false, hasSharedLink: false, telegramConnected: false, hasAsked: false });

    await h.pool.query(
      `INSERT INTO listings (agency_id, broker_id, code, listing_type, property_type, title, price_value, status)
       VALUES ($1, $2, 'T1', 'sale', 'apartment', 'Test Unit', 3000000, 'active')`,
      [verified.agency.id, verified.broker.id]
    );
    const me2 = await request(h.app.app).get("/api/v1/me").set("Authorization", `Bearer ${token}`);
    expect(me2.status).toBe(200);
    expect(me2.body.onboarding.hasUnit).toBe(true);

    const home2 = await request(h.app.app).get("/api/v1/today/home").set("Authorization", `Bearer ${token}`);
    expect(home2.status).toBe(200);
    expect(home2.body.onboarding.hasUnit).toBe(true);
    expect(home2.body.onboarding.hasAsked).toBe(false);

    await h.pool.query(
      `INSERT INTO usage_events (agency_id, broker_id, channel, event) VALUES ($1, $2, 'app', 'assistant_query_run')`,
      [verified.agency.id, verified.broker.id]
    );
    const me3 = await request(h.app.app).get("/api/v1/me").set("Authorization", `Bearer ${token}`);
    expect(me3.body.onboarding.hasAsked).toBe(true);
  });
});
