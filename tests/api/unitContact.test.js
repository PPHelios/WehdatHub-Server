// tests/api/unitContact.test.js — The app's owner contact and client link for one unit, under the unit privacy rules.
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

test("the unit's own broker gets the owner contact; a colleague is refused while details are restricted", async () => {
  await h.insertListing({ code: "A-1", compound: "Mivida" });
  await h.query(`UPDATE listings SET details = jsonb_build_object('owner_name', 'Owner Ali', 'owner_phone', '01012345678') WHERE code = 'A-1' AND agency_id = $1`, [h.BROKERS.broker.agency_id]);
  const mine = await api().get("/api/v1/units/A-1/contact").set(await login("broker"));
  expect(mine.status).toBe(200);
  expect(mine.body).toEqual({ name: "Owner Ali", phone: "01012345678" });
  const other = await api().get("/api/v1/units/A-1/contact").set(await login("colleague"));
  expect(other.status).toBe(403);
  expect(JSON.stringify(other.body)).not.toMatch(/0101234/);
});

test("another agency's unit has no contact and no link", async () => {
  await h.insertListing({ code: "B-1", agency_id: h.AGENCY_B, broker_id: h.BROKERS.rival.id });
  const auth = await login("broker");
  expect((await api().get("/api/v1/units/B-1/contact").set(auth)).status).toBe(404);
  expect((await api().post("/api/v1/units/B-1/share-link").set(auth).send({})).status).toBe(404);
});

test("a client link is made for an active unit only, and carries no internal data", async () => {
  await h.insertListing({ code: "A-1", compound: "Mivida" });
  await h.insertListing({ code: "A-S", compound: "Mivida", status: "sold" });
  const auth = await login("broker");
  const ok = await api().post("/api/v1/units/A-1/share-link").set(auth).send({ lang: "en" });
  expect(ok.status).toBe(200);
  expect(ok.body.url).toMatch(/^https?:\/\//);
  expect(ok.body.url).toContain("A-1");
  expect((await api().post("/api/v1/units/A-S/share-link").set(auth).send({})).status).toBe(409);
});
