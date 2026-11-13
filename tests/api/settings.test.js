// tests/api/settings.test.js — App settings: own choices for anyone, the two switches for the agency owner only.
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

async function auth(who) {
  if (h.BROKERS[who].lazy) await h.seedBroker(who);
  const b = h.BROKERS[who];
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const r = await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: b.phone, code });
  return { Authorization: `Bearer ${r.body.token}` };
}
const api = () => request(h.app.app);

test("a broker saves their own settings but not the owner switches", async () => {
  const a = await auth("broker");
  expect((await api().post("/api/v1/settings").set(a).send({ quietLine: false, draftStyle: "Short and warm" })).status).toBe(200);
  const got = await api().get("/api/v1/settings").set(a);
  expect(got.body.quietLine).toBe(false);
  expect(got.body.draftStyle).toBe("Short and warm");
  expect(got.body.switches).toBeNull();
  expect((await api().post("/api/v1/settings").set(a).send({ switches: { brokersMayWrite: false } })).status).toBe(403);
});

test("the agency owner flips the switches", async () => {
  const a = await auth("owner");
  expect((await api().post("/api/v1/settings").set(a).send({ switches: { brokersMayWrite: false, dataEntryOwners: false } })).status).toBe(200);
  const got = await api().get("/api/v1/settings").set(a);
  expect(got.body.switches).toEqual({ brokersMayWrite: false, dataEntryOwners: false });
});
