// tests/api/roleGates.test.js — What each role may open in the app: data entry is kept to units and owners, the plan is for
// managers, and the opened-links list answers on its own path (it used to be hidden behind the sent-links list).
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

test("data entry is refused the lead, deal, viewing and Ask pages", async () => {
  await h.query("UPDATE brokers SET role = 'data_entry' WHERE id = $1", [h.BROKERS.colleague.id]);
  const auth = await login("colleague");
  for (const path of ["/deals", "/commissions", "/links", "/opened-links", "/viewings"]) {
    expect((await api().get(`/api/v1${path}`).set(auth)).status).toBe(403);
  }
  expect((await api().post("/api/v1/ask").set(auth).send({ q: "hi" })).status).toBe(403);
});

test("brokers keep deals and sent links, and the opened-links list is its own path", async () => {
  const auth = await login("broker");
  expect((await api().get("/api/v1/deals").set(auth)).status).toBe(200);
  const sent = await api().get("/api/v1/links").set(auth);
  expect(sent.status).toBe(200);
  expect(sent.body).toHaveProperty("items");
  const opened = await api().get("/api/v1/opened-links").set(auth);
  expect(opened.status).toBe(200);
  expect(opened.body).toHaveProperty("rows");
});

test("the plan is for managers and the agency owner, not brokers", async () => {
  expect((await api().get("/api/v1/plan").set(await login("broker"))).status).toBe(403);
  await h.seedBroker("manager");
  expect((await api().get("/api/v1/plan").set(await login("manager"))).status).toBe(200);
});

test("data entry has the owners right by default and loses it when the agency owner switches it off", async () => {
  await h.query("UPDATE brokers SET role = 'data_entry' WHERE id = $1", [h.BROKERS.colleague.id]);
  const auth = await login("colleague");
  const on = await api().get("/api/v1/me").set(auth);
  expect(on.body.rights).toMatchObject({ dataEntry: true, owners: true });
  await h.query("UPDATE agencies SET crm_settings = crm_settings || '{\"data_entry_owners\":\"off\"}'::jsonb WHERE id = $1", [h.BROKERS.colleague.agency_id]);
  const off = await api().get("/api/v1/me").set(auth);
  expect(off.body.rights.owners).toBe(false);
});

test("lead rules, round robin and away are for managers; a broker is refused", async () => {
  await h.seedBroker("manager");
  const m = await login("manager");
  const rules = await api().get("/api/v1/team/rules").set(m);
  expect(rules.status).toBe(200);
  expect(rules.body).toHaveProperty("rules");
  expect(Array.isArray(rules.body.brokers)).toBe(true);
  const off = await api().post("/api/v1/team/routing").set(m).send({ roundRobin: false, order: [] });
  expect(off.status).toBe(200);
  expect(off.body.roundRobin).toBe(false);
  expect((await api().post(`/api/v1/team/${h.BROKERS.broker.id}/away`).set(m).send({ until: "2020-01-01" })).status).toBe(422);
  const b = await login("broker");
  expect((await api().get("/api/v1/team/rules").set(b)).status).toBe(403);
  expect((await api().post("/api/v1/team/routing").set(b).send({ roundRobin: true })).status).toBe(403);
});
