// tests/api/api.test.js — The app's JSON API: code sign-in, bearer sessions, and the units list under the same
// visibility and agency rules as the website.
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

/** Signs `who` in through the code flow and returns the bearer token. */
async function login(who) {
  const b = typeof who === "string" ? h.BROKERS[who] : who;
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const res = await api().post("/api/v1/auth/code/verify").send({ phone: b.phone, code });
  expect(res.status).toBe(200);
  return res.body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

test("nothing is open without a token", async () => {
  expect((await api().get("/api/v1/me")).status).toBe(401);
  expect((await api().get("/api/v1/units")).status).toBe(401);
  expect((await api().get("/api/v1/units").set("Authorization", "Bearer not-a-real-token-xxxxxxxxxxxx")).status).toBe(401);
});

test("asking for a code answers the same for a known and an unknown number", async () => {
  const known = await api().post("/api/v1/auth/code/request").send({ phone: h.BROKERS.broker.phone });
  const unknown = await api().post("/api/v1/auth/code/request").send({ phone: "201999999999" });
  expect(known.status).toBe(200);
  expect(unknown.status).toBe(200);
  expect(unknown.body).toEqual(known.body);
});

test("a code signs in once; a wrong code and a used code read the same", async () => {
  const b = h.BROKERS.broker;
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const wrong = await api().post("/api/v1/auth/code/verify").send({ phone: b.phone, code: code === "000000" ? "111111" : "000000" });
  expect(wrong.status).toBe(401);
  const ok = await api().post("/api/v1/auth/code/verify").send({ phone: b.phone, code });
  expect(ok.status).toBe(200);
  expect(ok.body.token).toMatch(/^[A-Za-z0-9_-]{20,100}$/);
  expect(ok.body.broker).toMatchObject({ id: b.id, name: "Broker One", role: "broker" });
  expect(ok.body.csrf).toBeUndefined();
  const again = await api().post("/api/v1/auth/code/verify").send({ phone: b.phone, code });
  expect(again.status).toBe(401);
  expect(again.body).toEqual(wrong.body);
});

test("a session token works for /me and stops working after logout", async () => {
  const token = await login("broker");
  const me = await api().get("/api/v1/me").set(auth(token));
  expect(me.status).toBe(200);
  expect(me.body.agency.name).toBe("Agency Alpha");
  expect((await api().post("/api/v1/auth/logout").set(auth(token))).status).toBe(200);
  expect((await api().get("/api/v1/me").set(auth(token))).status).toBe(401);
});

test("a deactivated broker's token stops working at once", async () => {
  const token = await login("colleague");
  await h.query("UPDATE brokers SET is_active = false WHERE id = $1", [h.BROKERS.colleague.id]);
  expect((await api().get("/api/v1/me").set(auth(token))).status).toBe(401);
});

async function seedUnits() {
  await h.insertListing({ code: "A-1", compound: "Mivida", listing_type: "sale", bedrooms: 3, price_value: 9e6 });
  await h.insertListing({ code: "A-2", compound: "Mivida", listing_type: "sale", bedrooms: 2, price_value: 6e6, broker_id: h.BROKERS.colleague.id });
  await h.insertListing({ code: "A-3", compound: "Hyde Park", listing_type: "rent", bedrooms: 3, price_value: 40000 });
  await h.insertListing({ code: "A-P", compound: "Mivida", is_private: true });
  await h.insertListing({ code: "A-S", compound: "Mivida", status: "sold" });
  await h.insertListing({ code: "B-1", compound: "Mivida", agency_id: h.AGENCY_B, broker_id: h.BROKERS.rival.id });
}

test("the list shows this agency's active units only, never private or other agencies' units", async () => {
  await seedUnits();
  const token = await login("broker");
  const res = await api().get("/api/v1/units").set(auth(token));
  expect(res.status).toBe(200);
  expect(res.body.items.map((u) => u.code).sort()).toEqual(["A-1", "A-2", "A-3"]);
  expect(res.body.total).toBe(3);
  const sold = await api().get("/api/v1/units?status=sold").set(auth(token));
  expect(sold.body.items.map((u) => u.code)).toEqual(["A-S"]);
});

test("the agency owner alone sees private units", async () => {
  await seedUnits();
  await h.seedBroker("owner");
  const owner = await login("owner");
  const res = await api().get("/api/v1/units").set(auth(owner));
  expect(res.body.items.map((u) => u.code)).toContain("A-P");
  const broker = await login("broker");
  expect((await api().get("/api/v1/units/A-P").set(auth(broker))).status).toBe(404);
  expect((await api().get("/api/v1/units/A-P").set(auth(owner))).status).toBe(200);
});

test("filters and paging narrow the list; the total counts the whole match", async () => {
  await seedUnits();
  const token = await login("broker");
  const by = async (qs) => (await api().get(`/api/v1/units?${qs}`).set(auth(token))).body;
  expect((await by("compound=Hyde%20Park")).items.map((u) => u.code)).toEqual(["A-3"]);
  expect((await by("deal=rent")).items.map((u) => u.code)).toEqual(["A-3"]);
  expect((await by("bedrooms=2")).items.map((u) => u.code)).toEqual(["A-2"]);
  expect((await by("mine=1")).items.map((u) => u.code).sort()).toEqual(["A-1", "A-3"]);
  expect((await by("pmax=7m")).items.map((u) => u.code).sort()).toEqual(["A-2", "A-3"]);
  const page = await by("limit=2&offset=0");
  expect(page.items).toHaveLength(2);
  expect(page.total).toBe(3);
  expect((await by("limit=2&offset=2")).items).toHaveLength(1);
});

test("one unit by code: another agency's unit is a 404 and no owner or commission data is returned", async () => {
  await seedUnits();
  const token = await login("broker");
  expect((await api().get("/api/v1/units/B-1").set(auth(token))).status).toBe(404);
  const one = await api().get("/api/v1/units/A-1").set(auth(token));
  expect(one.status).toBe(200);
  expect(one.body).toMatchObject({ code: "A-1", compound: "Mivida", bedrooms: 3, price: 9000000, mine: true });
  expect(Object.keys(one.body).join(" ")).not.toMatch(/owner|commission|phone|lat|lng|details/i);
});
