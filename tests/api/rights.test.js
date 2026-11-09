// tests/api/rights.test.js — The agency owner's switch for brokers adding and editing units, the rights the app reads at
// sign-in, and the counts on lists and search.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");
const Rights = require("../../services/unitRights");
const Store = require("../../lib/listingStore");

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
const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];

test("brokers may write by default, and /me tells the app", async () => {
  const me = await api().get("/api/v1/me").set(await login("broker"));
  expect(me.body.rights).toMatchObject({ addUnits: true, editUnits: true, leads: true, dataEntry: false, manager: false });
});

test("only the agency owner can switch it, and it limits brokers but not managers", async () => {
  await h.seedBroker("owner");
  expect((await Rights.setBrokersMayWrite(h.pool, await row("broker"), false)).ok).toBe(false);
  expect((await Rights.setBrokersMayWrite(h.pool, await row("owner"), false)).ok).toBe(true);
  expect(await Rights.mayWrite(h.pool, await row("broker"))).toBe(false);
  expect(await Rights.mayWrite(h.pool, await row("owner"))).toBe(true);
  const me = await api().get("/api/v1/me").set(await login("broker"));
  expect(me.body.rights).toMatchObject({ addUnits: false, editUnits: false });
  await Rights.setBrokersMayWrite(h.pool, await row("owner"), true);
  expect(await Rights.mayWrite(h.pool, await row("broker"))).toBe(true);
});

test("with the switch off the app's add routes refuse a broker, and the store refuses a patch", async () => {
  await h.seedBroker("owner");
  await h.insertListing({ code: "A-1", compound: "Mivida" });
  await Rights.setBrokersMayWrite(h.pool, await row("owner"), false);
  const auth = await login("broker");
  expect((await api().post("/api/v1/units/review").set(auth).send({})).status).toBe(403);
  expect((await api().post("/api/v1/units").set(auth).send({})).status).toBe(403);
  const unit = await Store.findByCode(h.pool, h.BROKERS.broker.agency_id, "A-1");
  const out = await Store.applyListingPatch(h.pool, await row("broker"), { listing: unit, patch: { bedrooms: 5 } });
  expect(out.forbidden).toBe(true);
  expect((await api().post("/api/v1/units/review").set(await login("owner")).send({})).status).not.toBe(403);
});

test("the units list carries the three status counts", async () => {
  await h.insertListing({ code: "A-1", compound: "Mivida" });
  await h.insertListing({ code: "A-2", compound: "Mivida" });
  await h.insertListing({ code: "A-S", compound: "Mivida", status: "sold" });
  const res = await api().get("/api/v1/units?status=sold").set(await login("broker"));
  expect(res.body.counts).toEqual({ active: 2, sold: 1, archived: 0 });
  expect(res.body.total).toBe(1);
});

test("lead lists carry a total and every tab has its count", async () => {
  const auth = await login("broker");
  const a = await api().post("/api/v1/leads").set(auth).send({ phone1: "01011112222", name: "Lead One", kind: "buyer" });
  expect(a.status).toBeLessThan(300);
  const list = await api().get("/api/v1/leads").set(auth);
  expect(list.body.total).toBe(1);
  const counts = await api().get("/api/v1/leads/counts").set(auth);
  expect(counts.status).toBe(200);
  expect(counts.body.counts.all).toBe(1);
  expect(counts.body.counts.new).toBe(1);
  expect(counts.body.counts.overdue).toBe(0);
});
