// tests/parity/validation-parity.test.js — The website and the app refuse and accept the same things (QA round 3, step 3).
// The same unit, lead and deal, with the same bad value, goes to the website form and to /api/v1; both must end the same
// way (saved, or refused), and what is saved must be the same value. A difference is a bug in one of the two doors.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const WebAuth = require("../../lib/webAuth");

jest.setTimeout(180000);

let h, web, app;
beforeAll(async () => {
  h = await createHarness();
  web = await signIn(h, "broker");
  const b = h.BROKERS.broker;
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  app = { Authorization: `Bearer ${(await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: b.phone, code })).body.token}` };
});
afterAll(closeHarness);

const UNIT = { listing_type: "sale", market: "resale", property_type: "apartment", compound: "Hyde Park", price_value: "8,500,000", area_value: "150", bedrooms: "3", bathrooms: "2", owner_name: "Mr Owner", owner_phone: "01099998888" };
let n = 0;
const unitRow = async (code) => (await h.query("SELECT price_value, area_value, bedrooms FROM listings WHERE code = $1", [code]))[0] || null;

async function unitBoth(change) {
  n++;
  const wCode = `PW-${n}`;
  const aCode = `PA-${n}`;
  let wr = web.agent.post("/app/units/new").field("_csrf", web.csrf).field("force", "1");
  for (const [k, v] of Object.entries({ ...UNIT, ...change, code: wCode })) wr = wr.field(k, String(v));
  await wr.redirects(0);
  await request(h.app.app).post("/api/v1/units").set(app).field("fields", JSON.stringify({ ...UNIT, ...change, code: aCode, compound_new: "1", force: "1" }));
  return { web: await unitRow(wCode), app: await unitRow(aCode) };
}

const CASES = {
  "valid unit": {},
  "price -5": { price_value: "-5" },
  "price abc": { price_value: "abc" },
  "area -50": { area_value: "-50" },
  "bedrooms 99": { bedrooms: "99" },
  "owner phone 123": { owner_phone: "123" },
  "no price": { price_value: "" }
};

test.each(Object.entries(CASES))("unit, %s: the website and the app end the same way", async (_name, change) => {
  const r = await unitBoth(change);
  const shape = (x) => (x ? { saved: true, price: Number(x.price_value), area: Number(x.area_value), bedrooms: x.bedrooms } : { saved: false });
  if (_name === "valid unit") expect(shape(r.web).saved).toBe(true); // positive control
  expect(shape(r.app)).toEqual(shape(r.web));
});

const leadRow = async (phone) => (await h.query("SELECT name, notes FROM leads WHERE array_to_string(phones, ',') LIKE '%' || $1 ORDER BY created_at DESC LIMIT 1", [String(phone).slice(-10)]))[0] || null;
let p = 0;
async function leadBoth(change) {
  p++;
  const wPhone = `0101000${String(1000 + p).slice(-4)}`;
  const aPhone = `0102000${String(1000 + p).slice(-4)}`;
  const base = { name: "Parity Lead", kind: "buyer", lawful_basis: "client_request", lawfulBasis: "client_request" };
  await web.agent.post("/app/leads/new").set("X-CSRF-Token", web.csrf).type("form").send({ ...base, ...change, phone1: change.phone1 === undefined ? wPhone : change.phone1 }).redirects(0);
  await request(h.app.app).post("/api/v1/leads").set(app).send({ ...base, ...change, phone1: change.phone1 === undefined ? aPhone : change.phone1 });
  return { web: await leadRow(change.phone1 || wPhone), app: await leadRow(change.phone1 || aPhone) };
}

test.each([
  ["valid lead", {}],
  ["name of 300 letters", { name: "ا".repeat(300) }],
  ["notes of 6000 letters", { notes: "x".repeat(6000) }]
])("lead, %s: the website and the app keep the same", async (_name, change) => {
  const r = await leadBoth(change);
  const shape = (x) => (x ? { saved: true, name: String(x.name || "").length, notes: String(x.notes || "").length } : { saved: false });
  if (_name === "valid lead") expect(shape(r.web).saved).toBe(true); // positive control
  expect(shape(r.app)).toEqual(shape(r.web));
});

test("lead with phone 123: refused by both", async () => {
  const before = (await h.query("SELECT count(*)::int AS n FROM leads"))[0].n;
  await web.agent.post("/app/leads/new").set("X-CSRF-Token", web.csrf).type("form").send({ name: "Bad", phone1: "123", kind: "buyer" }).redirects(0);
  const a = await request(h.app.app).post("/api/v1/leads").set(app).send({ name: "Bad", phone1: "123", kind: "buyer" });
  expect(a.status).toBeGreaterThanOrEqual(400);
  expect((await h.query("SELECT count(*)::int AS n FROM leads"))[0].n).toBe(before);
});
