// tests/api/viewings.test.js — The app sets a viewing without sending anything, sees it in the calendar, and lists shared links.
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

async function login(who) {
  const b = h.BROKERS[who];
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const res = await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: b.phone, code });
  return { Authorization: `Bearer ${res.body.token}` };
}
const api = () => request(h.app.app);

test("a viewing is set with its message and link, shows in the calendar, and a colleague cannot set one", async () => {
  await h.insertListing({ code: "A-1", compound: "Mivida" });
  const auth = await login("broker");
  const lead = (await api().post("/api/v1/leads").set(auth).send({ phone1: "01011112222", name: "Lead One", kind: "buyer" })).body.lead;
  const at = new Date(Date.now() + 2 * 86400 * 1000).toISOString();
  const made = await api().post(`/api/v1/leads/${lead.ref}/viewing`).set(auth).send({ at, unitCode: "A-1", place: "Gate 3", version: lead.version });
  expect(made.status).toBe(201);
  expect(made.body.message).toContain("Gate 3");
  expect(made.body.url).toMatch(/\/v\//);
  const cal = await api().get("/api/v1/viewings").set(auth);
  expect(cal.body.items.map((v) => v.leadRef)).toEqual([lead.ref]);
  expect(cal.body.items[0].unitCode).toBe("A-1");
  expect((await api().post(`/api/v1/leads/${lead.ref}/viewing`).set(await login("colleague")).send({ at })).status).toBe(404);
  expect((await api().post(`/api/v1/leads/${lead.ref}/viewing`).set(auth).send({ at: "nope" })).status).toBe(422);
});

test("sent links list the links this broker shared", async () => {
  await h.insertListing({ code: "A-1", compound: "Mivida" });
  const auth = await login("broker");
  await api().post("/api/v1/units/A-1/share-link").set(auth).send({ to: "01099998888" });
  const list = await api().get("/api/v1/links").set(auth);
  expect(list.body.items.map((l) => l.unitCode)).toEqual(["A-1"]);
  expect((await api().get("/api/v1/links").set(await login("colleague"))).body.items).toEqual([]);
});
