// tests/api/parity-round.test.js — The app's deal entry/correction, saved searches and catalogue editing use the website's services.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");
const Leads = require("../../services/leads");
const SearchLink = require("../../domain/searchLink");

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
const api = (m, p, auth, body) => request(h.app.app)[m](`/api/v1${p}`).set(auth).send(body);

test("a deal is recorded once from the app, and a manager corrects it", async () => {
  const broker = await login("broker");
  const admin = await login("admin");
  await Leads.captureLead(h.pool, { ...h.BROKERS.broker }, { phones: "01012345678", name: "Sara" });
  await h.insertListing({ code: "VIL-08", broker_id: h.BROKERS.broker.id });
  const body = { idem: "0123456789abcdef", lead: "L-0001", unit: "VIL-08", price: "8.5 مليون", commission: "2%", mark_sold: "1", status: "signed" };
  const first = await api("post", "/deals", broker, body);
  expect(first.status).toBe(200);
  expect(first.body.ref).toBe("D-0001");
  expect((await api("post", "/deals", broker, body)).body.ref).toBe("D-0001");
  expect(await h.query("SELECT 1 FROM deals")).toHaveLength(1);
  expect((await api("post", "/deals", broker, { ...body, idem: "aaaaaaaaaaaaaaaa", commission: "" })).status).toBe(422);
  expect((await api("post", "/deals/D-0001/correct", broker, { commission: "3%" })).status).toBe(403);
  const fixed = await api("post", "/deals/D-0001/correct", admin, { commission: "3%", price: "8500000", external: "" });
  expect(fixed.status).toBe(200);
  expect(Number((await h.query("SELECT commission_total FROM deals"))[0].commission_total)).toBe(255000);
});

test("saved searches: save, list, open, delete (own only)", async () => {
  const broker = await login("broker");
  const colleague = await login("colleague");
  await h.insertListing({ code: "HP-1", compound: "Hyde Park", price_value: 8.5e6 });
  const f = SearchLink.encodeFilters({ property_types: ["apartment"], places: [{ kind: "compound", key: "hyde_park" }], price_max: 9000000 });
  expect((await api("post", "/saved-searches", broker, { f, name: "" })).status).toBe(422);
  const saved = await api("post", "/saved-searches", broker, { f, name: "Hyde Park" });
  expect(saved.status).toBe(200);
  const list = await api("get", "/saved-searches", broker);
  expect(list.body.items.map((x) => x.name)).toEqual(["Hyde Park"]);
  expect((await api("get", `/saved-searches/${saved.body.id}`, broker)).body.name).toBe("Hyde Park");
  expect((await api("get", `/saved-searches/${saved.body.id}`, colleague)).status).toBe(404);
  expect((await api("post", `/saved-searches/${saved.body.id}/delete`, broker)).status).toBe(200);
  expect((await api("get", "/saved-searches", broker)).body.items).toEqual([]);
});

test("catalogue: a manager adds a developer from the app; a broker cannot", async () => {
  const broker = await login("broker");
  const admin = await login("admin");
  expect((await api("post", "/catalogue/developers", broker, { name: "Talaat" })).status).toBe(403);
  const out = await api("post", "/catalogue/developers", admin, { name: "Talaat" });
  expect(out.status).toBe(200);
  expect(await h.query("SELECT name FROM developers")).toEqual([{ name: "Talaat" }]);
});
