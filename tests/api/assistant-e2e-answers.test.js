"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");

jest.setTimeout(90000);

let h;
let managerToken;

beforeAll(async () => {
  h = await createHarness();
  await h.seedBroker("manager");
  const mgr = await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.manager.id]);
  const s = await WebAuth.createSession(h.pool, mgr[0]);
  managerToken = s.sid;
});

afterAll(async () => {
  await closeHarness(h);
});

const ask = (q, lang = "en") =>
  request(h.app.app)
    .post("/api/v1/assistant/query")
    .set("Authorization", `Bearer ${managerToken}`)
    .send({ q, mode: "auto", lang });

test("end-to-end answers: viewings list clients, Khaled showings returns Khaled scorecard, Egyptian Arabic phrases work, unknown questions clarify", async () => {
  const futureToday = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  await h.query(
    `INSERT INTO leads (agency_id, ref, name, phone_e164, phones, lawful_basis, stage, assigned_broker_id, follow_up_status, follow_up_kind, next_follow_up_at, last_contact_at)
     VALUES ($1, 901, 'Karim Mansour', '+201022220099', ARRAY['+201022220099']::text[], 'client_request', 'viewing', $2, 'open', 'viewing', $3, now())`,
    [h.AGENCY_A, h.BROKERS.manager.id, futureToday]
  );

  // 1. Scheduled showings today returns clients & broker
  const showingsRes = await ask("Who has showing today?", "en");
  expect(showingsRes.status).toBe(200);
  expect(showingsRes.body.intent).toBe("crm_viewings");
  const listCard = showingsRes.body.cards.find((c) => c.kind === "stuck_leads");
  expect(listCard).toBeTruthy();
  expect(listCard.items[0].name).toBe("Karim Mansour");

  // 2. Broker-specific showing count returns broker scorecard, not agency viewings
  const khaledRes = await ask("How many showings does Admin has?", "en");
  expect(khaledRes.status).toBe(200);
  expect(khaledRes.body.intent).toBe("crm_broker");

  // 3. Egyptian Arabic silent/non-responding brokers
  const discRes = await ask("الوسطاء اللي مش بيردوا", "ar");
  expect(discRes.status).toBe(200);
  expect(discRes.body.intent).toBe("crm_discipline");

  // 4. Unassigned leads in Egyptian Arabic
  const unassRes = await ask("عملاء بدون وسيط", "ar");
  expect(unassRes.status).toBe(200);
  expect(unassRes.body.intent).toBe("crm_leads");

  // 5. Unrecognized questions clarify instead of hitting Primary
  const unkEn = await ask("Who won the match?", "en");
  expect(unkEn.status).toBe(200);
  expect(unkEn.body.intent).toBe("clarify");

  const unkAr = await ask("مين كسب الماتش؟", "ar");
  expect(unkAr.status).toBe(200);
  expect(unkAr.body.intent).toBe("clarify");
});
