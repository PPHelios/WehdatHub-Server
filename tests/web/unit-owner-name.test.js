// tests/web/unit-owner-name.test.js — An owner phone needs a name: the web form asks for it, or uses the phone as the
// name when the broker ticks so; the store refuses a phone-only owner; a file import uses the phone as the name.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Store = require("../../lib/listingStore");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const FIELDS = { listing_type: "sale", market: "resale", property_type: "apartment", compound: "Hyde Park", price_value: "9 مليون", area_value: "150", bedrooms: "3", bathrooms: "2", finishing: "fully_finished", owner_phone: "01012345678" };
const post = (agent, csrf, fields) => {
  let r = agent.post("/app/units/new").field("_csrf", csrf);
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return r;
};
const digits = (s) => String(s || "").replace(/\D/g, "");

test("a phone with no name is refused and the form asks for the name", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  const r = await post(agent, csrf, { ...FIELDS, force: "1" });
  expect(r.status).toBe(422);
  expect(r.text).toContain("اسم المالك");
  expect((await h.query("SELECT count(*)::int AS n FROM listings WHERE agency_id = $1", [h.BROKERS.broker.agency_id]))[0].n).toBe(0);
});

test("ticking 'use the phone as the name' saves the unit with the phone as the owner's name", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  const r = await post(agent, csrf, { ...FIELDS, force: "1", owner_name_from_phone: "1" });
  expect(r.status).toBe(303);
  const [row] = await h.query("SELECT details FROM listings WHERE agency_id = $1", [h.BROKERS.broker.agency_id]);
  expect(digits(row.details.owner_name)).toContain("1012345678");
});

test("a typed owner name is kept as it is", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  const r = await post(agent, csrf, { ...FIELDS, force: "1", owner_name: "Mr Owner" });
  expect(r.status).toBe(303);
  const [row] = await h.query("SELECT details FROM listings WHERE agency_id = $1", [h.BROKERS.broker.agency_id]);
  expect(row.details.owner_name).toBe("Mr Owner");
});

test("the store refuses a phone-only owner on every path that calls it", async () => {
  const res = await Store.createListing(h.pool, h.BROKERS.broker, { fields: { listing_type: "sale", property_type: "apartment", price_value: 5e6, area_value: 100, details: { owner_phone: "01012345678" } }, code: null, lang: "en" });
  expect(res).toEqual({ owner_name_required: true });
});

test("the form page carries the photo tray and the zip picker", async () => {
  const { agent } = await signIn(h, "broker");
  const page = await agent.get("/app/units/new?lang=en");
  expect(page.text).toContain("unitPhotos.js");
  expect(page.text).toContain("zipread.js");
  expect(page.text).toContain("data-photo-tray");
  expect(page.text).toContain("data-photo-zip");
  expect(page.text).toContain('name="owner_name_from_phone"');
});
