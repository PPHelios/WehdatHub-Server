// tests/web/ai-blocked-paths.test.js — When the AI credits are used up (QA round 3, step 7), every AI feature on the website
// and the app answers with the plain sentence (lib/aiBlock.js), never a raw code or a server error, and the free path still
// gives the person something: search runs on the quick reader, "fill from the message" is filled by the quick reader, Ask
// and voice say what to do instead, lead capture still reads the phone.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const WebAuth = require("../../lib/webAuth");
const AI = require("../../lib/ai");

jest.setTimeout(120000);

const TEXT = "للبيع شقة 3 غرف 2 حمام 150 متر تشطيب كامل السعر 6 مليون مالك 01012345678";
const RAW = /PLAN_QUOTA_EXCEEDED|QUOTA|ai_blocked<|server_error|undefined|\[object/;
const quota = () => Object.assign(new Error("quota"), { code: "PLAN_QUOTA_EXCEEDED" });

let h;
beforeEach(async () => {
  h = await createHarness();
  AI.reset();
  AI.respond(() => quota());
});
afterAll(closeHarness);

const api = () => request(h.app.app);
async function bearer(who = "broker") {
  const b = h.BROKERS[who];
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  return { Authorization: `Bearer ${(await api().post("/api/v1/auth/code/verify").send({ phone: b.phone, code })).body.token}` };
}

test("app: fill from the message is filled by the quick reader, with the credits sentence", async () => {
  const res = await api().post("/api/v1/units/extract").set(await bearer()).send({ describe: TEXT });
  expect(res.status).toBe(402);
  expect(res.body).toMatchObject({ error: "ai_blocked", fallback: true });
  expect(res.body.message).not.toMatch(RAW);
  expect(res.body.message).toMatch(/القراءة السريعة|quick reader/);
  expect(res.body.fields).toMatchObject({ property_type: "apartment" });
  expect(String(res.body.fields.price_value || res.body.fields.price)).toMatch(/6/);
});

test("website: fill from the message is filled by the quick reader", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  const res = await agent.post("/app/units/extract").set("X-CSRF-Token", csrf).type("form").send({ describe: TEXT });
  expect(res.status).toBe(200);
  expect(res.text).toMatch(/القراءة السريعة|quick reader/);
  expect(res.text).toMatch(/6000000|6,000,000|6\.000\.000/);
  expect(res.text).not.toMatch(RAW);
});

test("app: a search the AI would read still runs on the quick reader", async () => {
  const res = await api().get("/api/v1/search").set(await bearer()).query({ q: "شقة 3 غرف", ai: "1" });
  expect(res.status).toBe(200);
  expect(["results", "none", "ask"]).toContain(res.body.status);
  if (res.body.source === "fallback") expect(res.body.aiError).toBe("PLAN_QUOTA_EXCEEDED");
});

test("app: voice search says to use the phone's own voice; Ask answers in words", async () => {
  const auth = await bearer();
  const voice = await api().post("/api/v1/search/voice").set(auth).attach("voice", Buffer.from("OggS fake"), { filename: "v.ogg", contentType: "audio/ogg" });
  expect([402, 400, 422]).toContain(voice.status);
  if (voice.status === 402) {
    expect(voice.body.fallback).toBe(true);
    expect(voice.body.message).not.toMatch(RAW);
  }
  const ask = await api().post("/api/v1/ask").set(auth).send({ question: "شقة في التجمع 3 غرف" });
  expect(ask.status).toBeLessThan(500);
  const said = ask.body.message || ask.body.answer || "";
  expect(said).toBeTruthy();
  expect(said).not.toMatch(RAW);
});

test("lead capture keeps reading the phone without the AI", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  const res = await agent.post("/app/leads/extract").set("X-CSRF-Token", csrf).type("form").send({ text: "عميل اسمه أحمد 01098765432 عايز شقة" });
  expect(res.status).toBeLessThan(500);
  expect(res.text).not.toMatch(RAW);
});

test("managers and the owner hear once at 80% and at 100% of the month's AI credits", async () => {
  const Billing = require("../../services/billing");
  await h.seedBroker("owner");
  await h.query("UPDATE agencies SET pilot = false WHERE id = $1", [h.AGENCY_A]);
  const useAi = async (n) => {
    for (let i = 0; i < n; i++) {
      await h.query("INSERT INTO operation_logs (agency_id, broker_id, operation_type, status, model_used, gemini_ms, metadata, created_at) VALUES ($1, $2, 'listing_extraction', 'success', 'gemini-x', 10, '{}', NOW())", [h.AGENCY_A, h.BROKERS.broker.id]);
    }
  };
  const warnings = async () => (await h.query("SELECT broker_id, title FROM notifications WHERE dedupe_key LIKE 'ai_credits_warn:%' ORDER BY title"));
  const { used, limit } = await Billing.checkAllowance(h.pool, h.AGENCY_A);
  await useAi(Math.ceil(limit * 0.8) - 1 - used);
  await Billing.checkAllowance(h.pool, h.AGENCY_A);
  await new Promise((r) => setTimeout(r, 100));
  expect(await warnings()).toEqual([]);
  await useAi(1);
  await Billing.checkAllowance(h.pool, h.AGENCY_A);
  await Billing.checkAllowance(h.pool, h.AGENCY_A);
  await new Promise((r) => setTimeout(r, 100));
  const at80 = await warnings();
  expect(at80.length).toBeGreaterThan(0);
  expect(at80.every((w) => /80%/.test(w.title))).toBe(true);
  expect(at80.map((w) => w.broker_id)).toContain(h.BROKERS.owner.id);
  expect(at80.map((w) => w.broker_id)).not.toContain(h.BROKERS.broker.id);
  await useAi(limit);
  await expect(Billing.checkAllowance(h.pool, h.AGENCY_A)).rejects.toMatchObject({ code: "PLAN_QUOTA_EXCEEDED" });
  await new Promise((r) => setTimeout(r, 100));
  expect((await warnings()).filter((w) => /100%/.test(w.title)).length).toBe(at80.length);
});
