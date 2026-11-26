"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const { resetConfig } = require("../../config");
const Signup = require("../../services/signup");

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
  h.WA.reset();
  await Signup.setOpen(h.pool, true);
});

afterEach(async () => {
  await closeHarness(h);
});

describe("API trial-options, solo/team signup, and WhatsApp send-first webhook", () => {
  test("GET /api/v1/auth/trial-options reflects dashboard settings dynamically", async () => {
    const r1 = await request(h.app.app).get("/api/v1/auth/trial-options");
    expect(r1.status).toBe(200);
    expect(r1.body.enabled).toBe(true);
    expect(r1.body.tiers.solo.enabled).toBe(true);
    expect(r1.body.tiers.team.enabled).toBe(true);
    expect(r1.body.waAvailable).toBe(true);

    await Signup.saveTrialSettings(h.pool, {
      open: "1",
      solo_enabled: "1",
      solo_days: "7",
      solo_credits: "40",
      team_enabled: "0",
      team_days: "14",
      team_credits: "120"
    });
    const r2 = await request(h.app.app).get("/api/v1/auth/trial-options");
    expect(r2.status).toBe(200);
    expect(r2.body.tiers.solo.days).toBe(7);
    expect(r2.body.tiers.solo.credits).toBe(40);
    expect(r2.body.tiers.team.enabled).toBe(false);
  });

  test("POST /api/v1/auth/signup starts telegram or whatsapp trial and activates on matching WhatsApp VERIFY", async () => {
    const bad = await request(h.app.app).post("/api/v1/auth/signup").send({ name: "Nora", phone: "123", tier: "solo", channel: "telegram" });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe("phone");

    const tgRes = await request(h.app.app).post("/api/v1/auth/signup").send({ name: "Nora", phone: "01022223333", tier: "solo", channel: "telegram" });
    expect(tgRes.status).toBe(200);
    expect(tgRes.body.ok).toBe(true);
    expect(tgRes.body.channel).toBe("telegram");
    expect(tgRes.body.verifyUrl).toContain("https://t.me/Wehdat_Hub_bot?start=su_");

    const waRes = await request(h.app.app).post("/api/v1/auth/signup").send({ name: "Omar", phone: "01055556666", tier: "solo", channel: "whatsapp" });
    expect(waRes.status).toBe(200);
    expect(waRes.body.ok).toBe(true);
    expect(waRes.body.channel).toBe("whatsapp");
    expect(waRes.body.verifyUrl).toContain("https://wa.me/201099990000?text=");

    const token = decodeURIComponent(waRes.body.verifyUrl.split("text=")[1]).replace(/^VERIFY\s+/, "");
    await h.app.handleWebhookBody({
      entry: [{ changes: [{ value: { messages: [{ id: "m1", from: "201055556666", type: "text", text: { body: `VERIFY ${token}` } }] } }] }]
    });

    const sent = h.WA.outbox || [];
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const bodyText = sent[sent.length - 1].text || "";
    const codeMatch = bodyText.match(/\b(\d{6})\b/);
    expect(codeMatch).not.toBeNull();

    const verifyRes = await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: "01055556666", code: codeMatch[1] });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.token).toBeTruthy();
  });
});
