// tests/api/viewReadOnly.test.js — While the test number views the other agency, the app's API is read-only, as the website is.
// Found by QA 2026-11-17: the site refused every write while viewing, but /api/v1 let writes through to the viewed agency.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");

jest.setTimeout(90000);

const SAVED = { ...process.env };
let h;
let headers;

beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("owner");
  const o = h.BROKERS.owner;
  // The owner is the test number in agency A; agency B is the one it may view.
  process.env.TEST_SWITCH_PHONE = o.phone;
  process.env.TEST_SWITCH_AGENCY_ID = o.agency_id;
  process.env.TEST_SWITCH_VIEW_AGENCY_ID = h.BROKERS.rival.agency_id;
  const code = await WebAuth.issueLoginCode(h.pool, { id: o.id, agency_id: o.agency_id });
  const token = (await api().post("/api/v1/auth/code/verify").send({ phone: o.phone, code })).body.token;
  headers = { Authorization: `Bearer ${token}` };
});
afterEach(() => {
  process.env = { ...SAVED };
});
afterAll(() => closeHarness());

const api = () => request(h.app.app);
const view = (v) => api().post("/api/v1/test-view").set(headers).send({ view: v });

test("while viewing the other agency, every write is refused with 403 read_only_view", async () => {
  expect((await view("other")).body.viewing).toBe(true);
  for (const [path, body] of [
    ["/api/v1/units", { fields: {} }],
    ["/api/v1/leads", { name: "X", phone1: "01155550101" }],
    ["/api/v1/deals", {}],
    ["/api/v1/team/invite", { name: "X", phone: "01155550102", role: "broker" }],
    ["/api/v1/units/AP-1/delete", {}]
  ]) {
    const r = await api().post(path).set(headers).send(body);
    expect([path, r.status, r.body.error]).toEqual([path, 403, "read_only_view"]);
  }
});

test("while viewing, reads still work and the view can be switched off", async () => {
  await view("other");
  expect((await api().get("/api/v1/units").set(headers)).status).toBe(200);
  expect((await view("home")).body.viewing).toBe(false);
  // Back home a write reaches validation again (422), not the read-only refusal.
  const r = await api().post("/api/v1/leads").set(headers).send({});
  expect(r.status).toBe(422);
});

test("nothing is written to the viewed agency, even by a write that gets past the route", async () => {
  await view("other");
  const before = (await h.pool.query("SELECT count(*)::int AS n FROM leads WHERE agency_id = $1", [h.BROKERS.rival.agency_id])).rows[0].n;
  await api().post("/api/v1/leads").set(headers).send({ name: "Sneaky", phone1: "01155550199", lawfulBasis: "client_request" });
  const after = (await h.pool.query("SELECT count(*)::int AS n FROM leads WHERE agency_id = $1", [h.BROKERS.rival.agency_id])).rows[0].n;
  expect(after).toBe(before);
});
