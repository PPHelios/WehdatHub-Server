// tests/web/map.test.js — The map: pins carry the number of units a broker can see (filters change it, private and other
// agencies' units never count), a pin opens its unit list, and only the CRM owner edits the places.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
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
  delete process.env.OWNER_BROKER_IDS;
  resetConfig();
  await closeHarness();
});

async function seedPlaces() {
  await h.query(
    `INSERT INTO map_places (name_key, name_en, name_ar, developer, district, lat, lng) VALUES
       ('mivida', 'Mivida', 'ميفيدا', 'Emaar Misr', 'New Cairo', 30.0058, 31.5377),
       ('hyde park', 'Hyde Park', 'هايد بارك', 'Mountain View', 'New Cairo', 29.98, 31.55)`
  );
}
async function seedUnits() {
  await h.insertListing({ code: "MV-1", compound: "Mivida", listing_type: "sale", bedrooms: 3, price_value: 9e6, finishing: "fully_finished" });
  await h.insertListing({ code: "MV-2", compound: "Mivida", listing_type: "sale", bedrooms: 2, price_value: 6e6 });
  await h.insertListing({ code: "MV-3", compound: "كمبوند ميفيدا", listing_type: "rent", bedrooms: 3, price_value: 40000, furnishing: "furnished" });
  await h.insertListing({ code: "MV-P", compound: "Mivida", is_private: true });
  await h.insertListing({ code: "MV-S", compound: "Mivida", status: "sold" });
  await h.insertListing({ code: "MV-R", compound: "Mivida", agency_id: h.AGENCY_B, broker_id: h.BROKERS.rival.id });
  await h.insertListing({ code: "NO-1", compound: "Unknown Place" });
}

test("a pin counts the active units of this agency in its compound, in either language, without private ones", async () => {
  await seedPlaces();
  await seedUnits();
  const b = await signIn(h, "broker");
  const res = await b.agent.get("/app/map/pins");
  expect(res.status).toBe(200);
  expect(res.body.pins).toHaveLength(1);
  expect(res.body.pins[0]).toMatchObject({ name: "Mivida", n: 3, lat: 30.0058, lng: 31.5377 });
  expect(res.body.unmapped).toBe(1);
  expect(res.body.facets.types).toEqual(["apartment"]);
});

test("filters change the count: sale or rent, rooms, finishing, furnishing and budget", async () => {
  await seedPlaces();
  await seedUnits();
  const b = await signIn(h, "broker");
  const n = async (q) => ((await b.agent.get(`/app/map/pins?${q}`)).body.pins[0] || { n: 0 }).n;
  expect(await n("type=sale")).toBe(2);
  expect(await n("type=rent")).toBe(1);
  expect(await n("rooms=3")).toBe(2);
  expect(await n("rooms=5")).toBe(0);
  expect(await n("fin=fully_finished")).toBe(1);
  expect(await n("furn=furnished")).toBe(1);
  expect(await n("type=sale&pmin=7000000")).toBe(1);
  expect(await n("type=sale&pmax=5000000")).toBe(0);
  expect(await n("ptype=villa")).toBe(0);
  expect(await n("type=bogus&rooms=abc")).toBe(3);
});

test("tapping a pin lists its units under the same filters; other agencies see nothing of them", async () => {
  await seedPlaces();
  await seedUnits();
  const b = await signIn(h, "broker");
  const place = (await h.query("SELECT id FROM map_places WHERE name_key = 'mivida'"))[0].id;
  const all = await b.agent.get(`/app/map/place/${place}`);
  expect(all.status).toBe(200);
  expect(all.text).toMatch(/MV-1/);
  expect(all.text).toMatch(/MV-3/);
  expect(all.text).not.toMatch(/MV-P|MV-S|MV-R|NO-1/);
  const rent = await b.agent.get(`/app/map/place/${place}?type=rent`);
  expect(rent.text).toMatch(/MV-3/);
  expect(rent.text).not.toMatch(/MV-1/);
  const rival = await signIn(h, "rival");
  expect((await rival.agent.get("/app/map/pins")).body.pins.map((p) => p.n)).toEqual([1]);
  expect((await rival.agent.get(`/app/map/place/${place}`)).text).not.toMatch(/MV-1/);
});

test("the Map page loads the map file's address and allows it in the page policy; without it the page says it is not set up", async () => {
  const b = await signIn(h, "broker");
  const page = await b.agent.get("/app/map?lang=en");
  expect(page.status).toBe(200);
  expect(page.text).toContain(`data-tiles="${TILES}"`);
  expect(page.text).toMatch(/data-f-fin/);
  expect(page.text).toMatch(/data-budget/);
  expect(page.headers["content-security-policy"]).toMatch(/connect-src 'self' https:\/\/pub-test\.r2\.dev/);
  delete process.env.MAP_TILES_URL;
  resetConfig();
  const off = await b.agent.get("/app/map?lang=en");
  expect(off.text).toMatch(/not set up/);
  expect(off.headers["content-security-policy"]).not.toMatch(/r2\.dev/);
});

test("only the CRM owner opens the places window; it saves a place from a pasted link, links a unit name and loads the first list", async () => {
  process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
  resetConfig();
  const broker = await signIn(h, "broker");
  expect((await broker.agent.get("/app/owner/map")).status).toBe(404);
  expect((await broker.agent.post("/app/owner/map").type("form").send({ _csrf: broker.csrf, name_en: "X" })).status).toBe(404);

  const crm = await signIn(h, "admin");
  expect((await crm.agent.get("/app/owner/map?lang=en")).status).toBe(200);
  const bad = await crm.agent.post("/app/owner/map").type("form").send({ _csrf: crm.csrf, name_en: "Mivida", maps_link: "https://maps.app.goo.gl/x" });
  expect(bad.headers.location).toMatch(/err=link_short/);
  const ok = await crm.agent.post("/app/owner/map").type("form").send({ _csrf: crm.csrf, name_en: "Mivida", name_ar: "ميفيدا", maps_link: "https://www.google.com/maps/@30.0058,31.5377,15z", verified: "on" });
  expect(ok.headers.location).toMatch(/msg=saved/);
  const dup = await crm.agent.post("/app/owner/map").type("form").send({ _csrf: crm.csrf, name_en: "Mivida Compound", lat: "30", lng: "31" });
  expect(dup.headers.location).toMatch(/err=duplicate/);

  await h.insertListing({ code: "EM-1", compound: "Emaar Mivida" });
  expect((await crm.agent.get("/app/owner/map?lang=en")).text).toMatch(/Emaar Mivida/);
  const link = await crm.agent.post("/app/owner/map/alias").type("form").send({ _csrf: crm.csrf, alias: "Emaar Mivida", place: "Mivida" });
  expect(link.headers.location).toMatch(/msg=alias/);
  Maps.clearCache();
  const pins = await signIn(h, "broker");
  expect((await pins.agent.get("/app/map/pins")).body.pins[0]).toMatchObject({ name: "Mivida", n: 1 });

  const seed = await crm.agent.post("/app/owner/map/import").type("form").send({ _csrf: crm.csrf });
  expect(seed.headers.location).toMatch(/msg=seed&n=\d+/);
  expect(Number(seed.headers.location.match(/n=(\d+)/)[1])).toBeGreaterThan(1000);
  expect((await h.query("SELECT count(*)::int AS n FROM map_places WHERE name_key = 'mivida'"))[0].n).toBe(1);
  const gone = await crm.agent.post(`/app/owner/map/${ok.headers.location.includes("saved") ? (await h.query("SELECT id FROM map_places WHERE name_key='mivida'"))[0].id : ""}/delete`).type("form").send({ _csrf: crm.csrf });
  expect(gone.headers.location).toMatch(/msg=deleted/);
});

test("a compound is matched to the approved list on save: details move to the notes, unknown names are flagged", async () => {
  await h.query(`INSERT INTO map_places (name_key, name_en, name_ar, lat, lng, approved) VALUES ('rehab', 'El Rehab', 'الرحاب', 30.06, 31.49, true), ('mivida', 'Mivida', 'ميفيدا', 30.0058, 31.5377, false)`);
  const Store = require("../../lib/listingStore");
  const admin = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];
  await h.insertListing({ code: "RH-1", compound: "x" });
  let listing = (await h.query("SELECT * FROM listings WHERE code = 'RH-1'"))[0];
  const ok = await Store.applyListingPatch(h.pool, admin, { listing, patch: { compound: "El Rehab 2, 3rd floor" } });
  expect(ok.listing).toMatchObject({ compound: "الرحاب", compound_en: "El Rehab", compound_state: null });
  expect(ok.listing.place_id).toBeTruthy();
  expect(ok.listing.details.notes).toMatch(/3rd floor/);
  listing = ok.listing;
  const bad = await Store.applyListingPatch(h.pool, admin, { listing, patch: { compound: "Mivida" } });
  expect(bad.listing).toMatchObject({ compound: "Mivida", compound_state: "needs_fix", place_id: null });
});
