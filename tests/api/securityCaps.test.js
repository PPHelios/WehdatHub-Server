// tests/api/securityCaps.test.js — Daily caps on owner phones and lists, paging depth, document photos, and the app demo sign-in.
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
afterEach(() => {
  for (const k of ["DEMO_LOGIN_ENABLED", "DEMO_LOGIN_PHONE", "DEMO_LOGIN_CODE", "DEMO_LOGIN_AGENCY_ID"]) delete process.env[k];
});
afterAll(() => closeHarness());

const api = () => request(h.app.app);
async function login(who) {
  const b = h.BROKERS[who];
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const res = await api().post("/api/v1/auth/code/verify").send({ phone: b.phone, code });
  return { Authorization: `Bearer ${res.body.token}` };
}
async function fillBucket(bucket, hits) {
  const start = new Date(Math.floor(Date.now() / 86400000) * 86400000).toISOString();
  await h.query("INSERT INTO web_rate_limits (bucket, window_start, hits) VALUES ($1, $2, $3) ON CONFLICT (bucket, window_start) DO UPDATE SET hits = $3", [bucket, start, hits]);
}

test("a broker over the daily owner phone cap gets 429, and a view under it is logged", async () => {
  await h.insertListing({ code: "A-1", compound: "Mivida" });
  await h.query(`UPDATE listings SET details = jsonb_build_object('owner_name', 'Owner Ali', 'owner_phone', '01012345678') WHERE code = 'A-1' AND agency_id = $1`, [h.BROKERS.broker.agency_id]);
  const auth = await login("broker");
  expect((await api().get("/api/v1/units/A-1/contact").set(auth)).status).toBe(200);
  const { rows } = await h.query("SELECT count(*)::int AS n FROM operation_logs WHERE operation_type = 'owner_phone_view' AND broker_id = $1", [h.BROKERS.broker.id]);
  expect(rows[0].n).toBe(1);
  await fillBucket(`owner_phones:broker:${h.BROKERS.broker.id}`, 50);
  const over = await api().get("/api/v1/units/A-1/contact").set(auth);
  expect(over.status).toBe(429);
  expect(over.body.error).toBe("daily_cap");
  expect(JSON.stringify(over.body)).not.toMatch(/0101234/);
});

test("a broker cannot page deeper than 200 into the unit list", async () => {
  const auth = await login("broker");
  expect((await api().get("/api/v1/units?offset=200").set(auth)).status).toBe(200);
  const deep = await api().get("/api/v1/units?offset=201").set(auth);
  expect(deep.status).toBe(403);
  expect(deep.body.error).toBe("too_deep");
});

test("a broker over the daily unit list cap gets 429", async () => {
  const auth = await login("broker");
  await h.insertListing({ code: "A-1", compound: "Mivida" });
  await fillBucket(`list_rows:units:broker:${h.BROKERS.broker.id}`, 1500);
  const res = await api().get("/api/v1/units").set(auth);
  expect(res.status).toBe(429);
  expect(res.body.error).toBe("daily_cap");
});

test("document photos are hidden from a colleague but shown to the unit's own broker", async () => {
  await h.insertListing({ code: "A-1", compound: "Mivida" });
  const { rows } = await h.query("SELECT id, agency_id FROM listings WHERE code = 'A-1' AND agency_id = $1", [h.BROKERS.broker.agency_id]);
  await h.query("INSERT INTO listing_images (listing_id, agency_id, url, position, role) VALUES ($1, $2, 'p/plain.jpg', 0, NULL), ($1, $2, 'p/contract.jpg', 1, 'document')", [rows[0].id, rows[0].agency_id]);
  await h.query("UPDATE agencies SET crm_settings = COALESCE(crm_settings, '{}'::jsonb) || '{\"secret_details\":\"all\"}'::jsonb WHERE id = $1", [rows[0].agency_id]);
  const mine = await api().get("/api/v1/units/A-1").set(await login("broker"));
  expect(mine.body.images).toHaveLength(2);
  const other = await api().get("/api/v1/units/A-1").set(await login("colleague"));
  expect(other.status).toBe(200);
  expect(other.body.images).toHaveLength(1);
});

test("app demo sign-in: the demo code works, and asking for a code sends nothing to the demo number", async () => {
  const b = h.BROKERS.broker;
  process.env.DEMO_LOGIN_ENABLED = "true";
  process.env.DEMO_LOGIN_PHONE = b.phone;
  process.env.DEMO_LOGIN_AGENCY_ID = b.agency_id;
  process.env.DEMO_LOGIN_CODE = "123456";
  const ask = await api().post("/api/v1/auth/code/request").send({ phone: b.phone });
  expect(ask.status).toBe(200);
  const { rows } = await h.query("SELECT count(*)::int AS n FROM web_login_tokens WHERE broker_id = $1 AND channel = 'code'", [b.id]);
  expect(rows[0].n).toBe(0);
  const ok = await api().post("/api/v1/auth/code/verify").send({ phone: b.phone, code: "123456" });
  expect(ok.status).toBe(200);
  expect(ok.body.token).toBeTruthy();
  const wrong = await api().post("/api/v1/auth/code/verify").send({ phone: b.phone, code: "654321" });
  expect(wrong.status).toBe(401);
  // Another broker never accepts the demo code.
  const c = h.BROKERS.colleague;
  expect((await api().post("/api/v1/auth/code/verify").send({ phone: c.phone, code: "123456" })).status).toBe(401);
});
