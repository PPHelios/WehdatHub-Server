// tests/api/devices.test.js — The app's phone registration and the Firebase alert channel.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const crypto = require("crypto");
const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");
const AppPush = require("../../lib/channels/apppush");
const { resetConfig } = require("../../config");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(() => {
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  resetConfig();
});
afterAll(() => closeHarness());

const api = () => request(h.app.app);
async function login(who) {
  const b = h.BROKERS[who];
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  return (await api().post("/api/v1/auth/code/verify").send({ phone: b.phone, code })).body.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const TOKEN = "fcm-token-".padEnd(40, "x");

test("registering needs a sign-in and a valid token", async () => {
  expect((await api().post("/api/v1/devices").send({ token: TOKEN, platform: "android" })).status).toBe(401);
  const t = await login("broker");
  expect((await api().post("/api/v1/devices").set(auth(t)).send({ token: "short", platform: "android" })).status).toBe(400);
  expect((await api().post("/api/v1/devices").set(auth(t)).send({ token: TOKEN, platform: "windows" })).status).toBe(400);
});

test("a token is saved once and moves to whoever signs in on that phone; removing it works", async () => {
  const a = await login("broker");
  expect((await api().post("/api/v1/devices").set(auth(a)).send({ token: TOKEN, platform: "android" })).status).toBe(200);
  expect((await api().post("/api/v1/devices").set(auth(a)).send({ token: TOKEN, platform: "android" })).status).toBe(200);
  let rows = (await h.pool.query("SELECT broker_id FROM device_tokens")).rows;
  expect(rows).toHaveLength(1);
  const b = await login("colleague");
  await api().post("/api/v1/devices").set(auth(b)).send({ token: TOKEN, platform: "ios" });
  rows = (await h.pool.query("SELECT broker_id, platform FROM device_tokens")).rows;
  expect(rows).toEqual([{ broker_id: h.BROKERS.colleague.id, platform: "ios" }]);
  await api().post("/api/v1/devices/remove").set(auth(a)).send({ token: TOKEN });
  expect((await h.pool.query("SELECT 1 FROM device_tokens")).rows).toHaveLength(1);
  await api().post("/api/v1/devices/remove").set(auth(b)).send({ token: TOKEN });
  expect((await h.pool.query("SELECT 1 FROM device_tokens")).rows).toHaveLength(0);
});

test("the channel does nothing without Firebase set up, sends to the broker's phones, and drops dead tokens", async () => {
  const broker = h.BROKERS.broker;
  await h.pool.query("INSERT INTO device_tokens (broker_id, agency_id, token, platform) VALUES ($1, $2, $3, 'android'), ($1, $2, $4, 'ios')", [broker.id, broker.agency_id, TOKEN, "dead-token-".padEnd(40, "y")]);
  const message = { title: "New lead", url: "/app/leads/L-0001", push: { title: "عميل جديد", body: "Call 01012345678 now" } };
  expect((await AppPush.send(broker, message, { pool: h.pool })).error).toBe("not_configured");

  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ project_id: "p", client_email: "x@p.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
  resetConfig();
  const seen = [];
  AppPush.setSenderForTests(async (_sa, token, payload) => {
    seen.push({ token, payload });
    return token === TOKEN ? { ok: true } : { gone: true };
  });
  const r = await AppPush.send(broker, message, { pool: h.pool });
  expect(r).toMatchObject({ ok: true, sent: 1 });
  expect(seen[0].payload.body).not.toMatch(/01012345678/);
  expect(seen[0].payload.data.url).toBe("/app/leads/L-0001");
  expect((await h.pool.query("SELECT token FROM device_tokens")).rows.map((x) => x.token)).toEqual([TOKEN]);
});

test("/config tells the app its Firebase identifiers only when they are set and well formed", async () => {
  expect((await api().get("/api/v1/config")).body.firebase).toBeNull();
  const ok = { apiKey: "k", appId: "1:2:android:3", projectId: "p", messagingSenderId: "2" };
  process.env.FIREBASE_CLIENT_CONFIG = JSON.stringify({ android: ok, ios: { apiKey: "k" } });
  try {
    expect((await api().get("/api/v1/config")).body.firebase).toEqual({ android: ok });
  } finally {
    delete process.env.FIREBASE_CLIENT_CONFIG;
  }
});
