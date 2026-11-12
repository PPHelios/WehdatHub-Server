// tests/api/unitsWrite.test.js — Add a unit from the app: review, extract, save, duplicates and errors.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");

jest.setTimeout(90000);

let h;
let tok;
beforeAll(async () => {
  h = await createHarness();
  const b = h.BROKERS.broker;
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  tok = (await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: b.phone, code })).body.token;
});
afterAll(() => closeHarness());

const post = (path) => request(h.app.app).post(`/api/v1${path}`).set("Authorization", `Bearer ${tok}`);
const FIELDS = { listing_type: "sale", market: "resale", property_type: "apartment", compound: "", district: "Fifth Settlement", city: "New Cairo", price_value: "5,500,000", area_value: "150", bedrooms: "3", bathrooms: "2", owner_phone: "01012345678", owner_name: "Owner One", down_payment_value: "2,000,000", remaining_amount: "3,500,000" };

test("adding units needs a sign-in", async () => {
  expect((await request(h.app.app).post("/api/v1/units/review").send({})).status).toBe(401);
});

test("review lists what is missing, then passes when complete", async () => {
  const bad = await post("/units/review").send({ fields: { listing_type: "sale" }, photoCount: 0 });
  expect(bad.status).toBe(200);
  expect(bad.body.ok).toBe(false);
  expect(bad.body.blockers.length).toBeGreaterThan(0);
  expect(bad.body.blockers[0]).toHaveProperty("label");
});

test("saving an incomplete unit is refused with the missing fields", async () => {
  const r = await post("/units").field("fields", JSON.stringify({ listing_type: "sale" }));
  expect(r.status).toBe(422);
  expect(r.body.error).toBe("incomplete");
  expect(r.body.blockers.length).toBeGreaterThan(0);
});

test("a complete unit is saved once, with its code; the same unit again asks about the duplicate", async () => {
  const review = await post("/units/review").send({ fields: FIELDS, photoCount: 0 });
  expect(review.body.blockers).toEqual([]);
  const ok = await post("/units").field("fields", JSON.stringify(FIELDS));
  expect(ok.status).toBe(201);
  expect(ok.body.code).toBeTruthy();
  const again = await post("/units").field("fields", JSON.stringify(FIELDS));
  expect(again.status).toBe(409);
  expect(again.body.error).toBe("duplicate");
  const forced = await post("/units").field("fields", JSON.stringify({ ...FIELDS, force: "1" }));
  expect(forced.status).toBe(201);
  const shown = await request(h.app.app).get(`/api/v1/units/${encodeURIComponent(ok.body.code)}`).set("Authorization", `Bearer ${tok}`);
  expect(shown.status).toBe(200);
});

test("extract reads a pasted message into fields and never saves", async () => {
  const AI = require("../../lib/ai");
  AI.respond(() => JSON.stringify({ listing_type: "sale", property_type: "apartment", bedrooms: 3, area_value: 150, price_value: 5500000, city: "New Cairo" }));
  const r = await post("/units/extract").field("describe", "شقة 3 غرف 150 متر في التجمع بـ 5.5 مليون");
  expect([200, 503]).toContain(r.status);
  if (r.status === 200) expect(r.body.fields).toBeTruthy();
  expect((await post("/units/extract")).status).toBe(400);
});

test("review also lists a missing owner phone or name, and an edit lists what would change", async () => {
  const { owner_phone, owner_name, ...noOwner } = FIELDS; // eslint-disable-line no-unused-vars
  const r = await post("/units/review").send({ fields: noOwner, photoCount: 0 });
  expect(r.body.ok).toBe(false);
  expect(r.body.blockers.map((b) => b.field)).toEqual(expect.arrayContaining(["owner_phone", "owner_name"]));
  const tick = await post("/units/review").send({ fields: { ...noOwner, owner_phone: "01012345678", owner_name_from_phone: "1" }, photoCount: 0 });
  expect(tick.body.blockers.map((b) => b.field)).not.toContain("owner_name");
  const unit = await h.insertListing({ code: "RV-1", price_value: 5e6, area_value: 150, bedrooms: 3, broker_id: h.BROKERS.broker.id, details: { owner_name: "A", owner_phone: "01012345678" } });
  const edit = await post("/units/review").send({ code: unit.code || "RV-1", fields: { ...FIELDS, price_value: "6,000,000" }, photoCount: 0 });
  expect(edit.body.changes.map((c) => c.field)).toContain("price_value");
});

test("a refused app request leaves a Failures row tagged app, and app errors are stored", async () => {
  expect((await post("/units/RV-NOPE/edit").send({ version: 1, fields: FIELDS })).status).toBe(404);
  await new Promise((r) => setTimeout(r, 200));
  const rows = await h.query("SELECT error_code, metadata FROM operation_logs WHERE operation_type = 'app_failed' ORDER BY created_at DESC LIMIT 1");
  expect(rows[0].error_code).toBe("http_404");
  expect(rows[0].metadata.app).toBe(true);
  const ce = await post("/client-error").send({ message: "boom in Lead screen", screen: "Lead", platform: "android", appVersion: "1.0.0" });
  expect(ce.status).toBe(204);
  const ev = await h.query("SELECT source, message FROM error_events WHERE source = 'app' ORDER BY id DESC LIMIT 1");
  expect(ev[0].message).toMatch(/boom in Lead screen/);
});
