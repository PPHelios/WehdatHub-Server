"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

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

describe("TrialSignup WhatsApp send-first & solo/team dynamic tiers", () => {
  test("start with channel whatsapp returns wa.me link with VERIFY token and activates on matching phone", async () => {
    const started = await TrialSignup.start(
      h.pool,
      { agency: "Kareem Solo", name: "Kareem", phone: "01012345678", lang: "ar", tier: "solo", channel: "whatsapp" },
      { waNumber: "201099990000" }
    );
    expect(started.ok).toBe(true);
    expect(started.channel).toBe("whatsapp");
    expect(started.url).toContain("https://wa.me/201099990000?text=");
    expect(started.token).toMatch(/^su_/);

    // Mismatched sender phone fails without consuming token
    const mismatch = await TrialSignup.verifyWhatsApp(h.pool, started.token, "201199998888");
    expect(mismatch.error).toBe("mismatch");

    // Matching sender phone activates agency, owner broker, and returns 6-digit login code
    const verified = await TrialSignup.verifyWhatsApp(h.pool, started.token, "201012345678");
    expect(verified.ok).toBe(true);
    expect(verified.agency.name).toBe("Kareem Solo");
    expect(verified.broker.is_active).toBe(true);
    expect(verified.loginCode).toMatch(/^\d{6}$/);

    // Reusing the same phone for a second trial is blocked
    const second = await TrialSignup.start(
      h.pool,
      { agency: "Kareem 2", name: "Kareem", phone: "01012345678", lang: "ar", tier: "solo", channel: "whatsapp" },
      { waNumber: "201099990000" }
    );
    expect(second.error).toBe("trial_used");
  });
});
