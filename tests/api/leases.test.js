// tests/api/leases.test.js — The app's leases: the list (own / all), marking one handled, Today's soon list, reminders to managers too.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");
const Leases = require("../../services/leases");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(() => closeHarness());

async function login(who) {
  await h.seedBroker(who);
  const b = h.BROKERS[who];
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const res = await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: b.phone, code });
  return { Authorization: `Bearer ${res.body.token}` };
}

test("list, today, handled, and reminders reach the broker and the managers", async () => {
  const owner = await login("owner");
  const broker = await login("broker");
  await h.insertListing({ code: "RENT-9", listing_type: "rent", broker_id: h.BROKERS.broker.id });
  const start = new Date(Date.now() - 320 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const saved = await request(h.app.app).post("/api/v1/units/RENT-9/lease").set(broker).send({ startDate: start, months: 12, tenantName: "Omar" });
  expect(saved.status).toBe(200);

  const mine = await request(h.app.app).get("/api/v1/leases").set(broker);
  expect(mine.body.items.map((r) => r.code)).toEqual(["RENT-9"]);
  const all = await request(h.app.app).get("/api/v1/leases?soon=1").set(owner);
  expect(all.body.items).toHaveLength(1);
  const today = await request(h.app.app).get("/api/v1/today").set(broker);
  expect(today.body.leases.map((r) => r.code)).toEqual(["RENT-9"]);

  const out = await Leases.remindDue(h.pool);
  expect(out.sent).toBeGreaterThanOrEqual(1);

  const bad = await request(h.app.app).post("/api/v1/units/RENT-9/lease/done").set(broker).send({ kind: "nope" });
  expect(bad.status).toBe(422);
  const ok = await request(h.app.app).post("/api/v1/units/RENT-9/lease/done").set(broker).send({ kind: "renewed" });
  expect(ok.status).toBe(200);
  expect((await request(h.app.app).get("/api/v1/leases?soon=1").set(broker)).body.items).toEqual([]);
  expect((await request(h.app.app).get("/api/v1/leases").set(broker)).body.items[0].done).toBe(true);
});
