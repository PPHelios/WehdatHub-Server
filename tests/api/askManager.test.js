// tests/api/askManager.test.js — A broker asks a manager for help on a lead; the manager sees the request and handles it.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(() => closeHarness());

const api = () => request(h.app.app);
async function login(who) {
  const b = h.BROKERS[who];
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const res = await api().post("/api/v1/auth/code/verify").send({ phone: b.phone, code });
  return { Authorization: `Bearer ${res.body.token}` };
}

test("ask manager: empty and repeated asks are refused; the manager sees and handles it", async () => {
  const broker = await login("broker");
  const made = await api().post("/api/v1/leads").set(broker).send({ phone1: "01011112222", name: "Lead One", kind: "buyer" });
  const ref = made.body.lead.ref;
  expect((await api().post(`/api/v1/leads/${ref}/request`).set(broker).send({ text: " " })).status).toBe(422);
  const ask = await api().post(`/api/v1/leads/${ref}/request`).set(broker).send({ text: "Client wants a discount" });
  expect(ask.status).toBe(200);
  expect((await api().post(`/api/v1/leads/${ref}/request`).set(broker).send({ text: "again" })).status).toBe(409);
  const mine = await api().get(`/api/v1/leads/${ref}/requests`).set(broker);
  expect(mine.body.items.map((x) => x.note)).toEqual(["Client wants a discount"]);
  expect((await api().get("/api/v1/requests").set(broker)).status).toBe(403);
  expect((await api().post(`/api/v1/leads/${ref}/request/handle`).set(broker).send({ reply: "x" })).status).toBe(403);
  const mgr = await login("admin");
  const list = await api().get("/api/v1/requests").set(mgr);
  expect(list.status).toBe(200);
  expect(list.body.items.map((x) => x.ref)).toEqual([ref]);
  const done = await api().post(`/api/v1/leads/${ref}/request/handle`).set(mgr).send({ reply: "Offer 5%" });
  expect(done.status).toBe(200);
  expect(done.body.closed).toBe(1);
  expect((await api().get("/api/v1/requests").set(mgr)).body.items).toEqual([]);
});
