// tests/web/unit-property-type.test.js — The property type is written on the unit card and the details page, ar and en.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const WebAuth = require("../../lib/webAuth");
const { resultItem } = require("../../web/views/units");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("manager");
});
afterAll(closeHarness);

test("card shows the type badge in both languages", () => {
  const l = { code: "V-1", property_type: "villa", listing_type: "sale", compound: "X", details: {} };
  const en = resultItem(l, "en").toString();
  expect(en).toMatch(/data-property-type="villa"[^>]*>Villa</);
  expect(resultItem(l, "ar").toString()).toMatch(/data-property-type="villa"[^>]*>فيلا</);
  expect(resultItem({ ...l, property_type: null }, "en").toString()).not.toContain("data-property-type");
});

test("details page shows the type pill", async () => {
  await h.insertListing({ code: "D-1", property_type: "duplex" });
  const { agent } = await signIn(h, "manager");
  expect((await agent.get("/app/units/D-1?lang=en")).text).toMatch(/data-property-type="duplex"[^>]*>Duplex</);
  expect((await agent.get("/app/units/D-1?lang=ar")).text).toMatch(/data-property-type="duplex"[^>]*>دوبلكس</);
});

test("API list and detail carry propertyType", async () => {
  await h.insertListing({ code: "P-1", property_type: "penthouse" });
  const b = h.BROKERS.manager;
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const v = await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: b.phone, code });
  const auth = { Authorization: `Bearer ${v.body.token}` };
  const list = await request(h.app.app).get("/api/v1/units").set(auth);
  expect(list.body.items.find((i) => i.code === "P-1").propertyType).toBe("penthouse");
  expect((await request(h.app.app).get("/api/v1/units/P-1").set(auth)).body.propertyType).toBe("penthouse");
});
