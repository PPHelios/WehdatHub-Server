// tests/api/map.test.js — The app's map: pins and unit lists under the same visibility rule as the website's Map page.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");
const { resetConfig } = require("../../config");
const Maps = require("../../services/mapPlaces");

jest.setTimeout(90000);

const TILES = "https://pub-test.r2.dev/egypt.pmtiles";
let h;
beforeEach(async () => {
  h = await createHarness();
  process.env.MAP_TILES_URL = TILES;
  Maps.clearCache();
  resetConfig();
});
afterAll(async () => {
  delete process.env.MAP_TILES_URL;
  resetConfig();
  await closeHarness();
});

const api = () => request(h.app.app);
async function login(who) {
  const b = h.BROKERS[who];
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  return (await api().post("/api/v1/auth/code/verify").send({ phone: b.phone, code })).body.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function seed() {
  await h.query(
    `INSERT INTO map_places (name_key, name_en, name_ar, developer, district, lat, lng)
     VALUES ('mivida', 'Mivida', 'ميفيدا', 'Emaar Misr', 'New Cairo', 30.0058, 31.5377) ON CONFLICT (name_key) DO NOTHING`
  );
  await h.insertListing({ code: "MV-1", compound: "Mivida", listing_type: "sale", bedrooms: 3, price_value: 9e6 });
  await h.insertListing({ code: "MV-2", compound: "Mivida", listing_type: "sale", bedrooms: 2, price_value: 6e6 });
  await h.insertListing({ code: "MV-P", compound: "Mivida", is_private: true });
  await h.insertListing({ code: "MV-R", compound: "Mivida", agency_id: h.AGENCY_B, broker_id: h.BROKERS.rival.id });
}

test("the map needs a sign-in", async () => {
  expect((await api().get("/api/v1/map")).status).toBe(401);
});

test("pins count only the units this broker may see, and the tiles address is sent along", async () => {
  await seed();
  const token = await login("broker");
  const res = await api().get("/api/v1/map").set(auth(token));
  expect(res.status).toBe(200);
  expect(res.body.tilesUrl).toBe(TILES);
  expect(res.body.pins).toHaveLength(1);
  expect(res.body.pins[0]).toMatchObject({ name: "Mivida", n: 2 });
  const filtered = await api().get("/api/v1/map?type=sale&pmin=7000000").set(auth(token));
  expect(filtered.body.pins[0].n).toBe(1);
});

test("a pin opens its units, never private or other agencies' ones", async () => {
  await seed();
  const token = await login("broker");
  const pin = (await api().get("/api/v1/map").set(auth(token))).body.pins[0];
  const res = await api().get(`/api/v1/map/places/${pin.id}/units`).set(auth(token));
  expect(res.status).toBe(200);
  expect(res.body.items.map((u) => u.code).sort()).toEqual(["MV-1", "MV-2"]);
  expect((await api().get("/api/v1/map/places/00000000-0000-0000-0000-000000000000/units").set(auth(token))).status).toBe(404);
});
