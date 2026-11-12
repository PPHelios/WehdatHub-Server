// tests/api/usage.test.js — Phone usage events are cleaned and stored, and old detail rows roll up into daily totals.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");
const UsageLog = require("../../lib/usageLog");
const { rollUp } = require("../../lib/logRollup");

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

test("cleanBatch keeps allowlisted events and drops text meta", () => {
  const out = UsageLog.cleanBatch({ events: [{ event: "ask", ms: 1200.4, meta: { screen: "Ask", phone: "0101", count: 3 } }, { event: "nope" }, { event: "flyer_make", ok: false }] });
  expect(out).toEqual([
    { event: "ask", ok: true, ms: 1200, meta: { screen: "Ask", count: 3 } },
    { event: "flyer_make", ok: false, ms: null, meta: null }
  ]);
});

test("POST /usage-events stores events and always answers 204", async () => {
  const auth = await login("owner");
  const res = await request(h.app.app).post("/api/v1/usage-events").set(auth).send({ events: [{ event: "ask", ms: 900 }, { event: "bogus" }] });
  expect(res.status).toBe(204);
  const rows = await h.query("SELECT event, channel, ms FROM usage_events");
  expect(rows).toEqual([{ event: "ask", channel: "app", ms: 900 }]);
  const bad = await request(h.app.app).post("/api/v1/usage-events").set(auth).send("x");
  expect(bad.status).toBe(204);
});

test("rollUp turns rows older than 90 days into daily totals and deletes the detail", async () => {
  const b = await h.seedBroker("owner");
  const old = new Date(Date.now() - 100 * 86400000).toISOString();
  for (const ms of [100, 300]) await h.query("INSERT INTO usage_events (created_at, agency_id, broker_id, channel, event, ms) VALUES ($1, $2, $3, 'app', 'ask', $4)", [old, b.agency_id, b.id, ms]);
  await h.query("INSERT INTO usage_events (agency_id, broker_id, channel, event, ms) VALUES ($1, $2, 'app', 'ask', 50)", [b.agency_id, b.id]);
  const out = await rollUp(h.pool);
  expect(out.rolled_usage_events).toBe(2);
  const sum = await h.query("SELECT n, ok_n, ms_avg, ms_max FROM log_daily_summary WHERE source = 'usage_events' AND name = 'ask'");
  expect(sum).toEqual([{ n: 2, ok_n: 2, ms_avg: 200, ms_max: 300 }]);
  expect((await h.query("SELECT count(*)::int AS n FROM usage_events"))[0].n).toBe(1);
});
