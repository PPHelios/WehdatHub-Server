// tests/router/portal-enquiry-reply.test.js — A forwarded Bayut enquiry gets one reply ("Saved"), never the
// "could not determine the requested action" fallback (the reply must be awaited before the turn ends).
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness, textOf, FALLBACK_AR } = require("../harness/app");

jest.setTimeout(30000);

let h;
beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("manager");
});
afterAll(closeHarness);

const enquiry = (no = "503956661") =>
  `You have received a new enquiry on Bayut.\nEnquirer Details:\nName: Khaled El-Sawy\nProperty Link: https://www.bayut.eg/pm/${no}/2662e7a7-7689-4a1c-9803-42d7977cf71a`;

describe("Forwarded portal enquiry replies (routes/dispatch.js)", () => {
  test("a manager's forwarded Bayut enquiry gets the Saved reply and no fallback", async () => {
    const replies = await h.text("manager", enquiry());
    expect(textOf(replies)).toMatch(/اتسجل استفسار Bayut/);
    expect(textOf(replies)).not.toMatch(FALLBACK_AR);
    expect(replies.filter((r) => /استفسار/.test(r.text || ""))).toHaveLength(1);
  });

  test("the manager's next texts add the phone and broker, and the enquiry becomes a lead", async () => {
    await h.text("manager", enquiry("503956663"));
    expect(textOf(await h.text("manager", "+201012345678"))).toMatch(/Broker|وسيط/);
    const done = await h.text("manager", "Broker One");
    expect(textOf(done)).toMatch(/Broker One/);
    expect(textOf(done)).not.toMatch(FALLBACK_AR);
    const [e] = await h.query("SELECT status, phone_e164, assigned_broker_id FROM portal_enquiries WHERE listing_no = '503956663'");
    expect(e).toMatchObject({ status: "assigned", phone_e164: "+201012345678", assigned_broker_id: h.BROKERS.broker.id });
  });

  test("skip ends the phone step and leaves the enquiry in Portal enquiries", async () => {
    await h.text("manager", enquiry("503956664"));
    expect(textOf(await h.text("manager", "skip"))).toMatch(/Portal enquiries|استفسارات البوابات/);
    const [e] = await h.query("SELECT status FROM portal_enquiries WHERE listing_no = '503956664'");
    expect(e.status).toBe("new");
  });

  test("a repeat of the same enquiry gets the already-saved reply and no fallback", async () => {
    await h.text("manager", enquiry("503956662"));
    const again = await h.text("manager", enquiry("503956662"));
    expect(textOf(again)).toMatch(/قبل كده/);
    expect(textOf(again)).not.toMatch(FALLBACK_AR);
  });
});
