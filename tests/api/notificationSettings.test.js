// tests/api/notificationSettings.test.js — The app's notification choices match the website's Settings.
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
  return (await api().post("/api/v1/auth/code/verify").send({ phone: b.phone, code })).body.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

test("the settings need a sign-in", async () => {
  expect((await api().get("/api/v1/notification-settings")).status).toBe(401);
});

test("a broker sees only the alert kinds for their role, and saves channel, quiet hours and reminders", async () => {
  const t = await login("broker");
  const before = await api().get("/api/v1/notification-settings").set(auth(t));
  expect(before.status).toBe(200);
  expect(Object.keys(before.body.kinds)).toContain("follow_up");
  expect(Object.keys(before.body.kinds)).not.toContain("manager_alert");

  const saved = await api()
    .put("/api/v1/notification-settings")
    .set(auth(t))
    .send({ kinds: { follow_up: { channel: "telegram", on: true } }, quiet: { enabled: false, start: 22, end: 8 }, reminderMinutes: [30, 120] });
  expect(saved.status).toBe(200);
  expect(saved.body.kinds.follow_up.channel).toBe("telegram");
  expect(saved.body.quiet.enabled).toBe(false);
  expect(saved.body.reminderMinutes).toEqual([30, 120]);
});

test("values outside the allowed lists are ignored", async () => {
  const t = await login("broker");
  const r = await api().put("/api/v1/notification-settings").set(auth(t)).send({ kinds: { follow_up: { channel: "fax", frequency: "weekly" } } });
  expect(r.status).toBe(200);
  expect(r.body.kinds.follow_up.channel).not.toBe("fax");
  expect(r.body.kinds.follow_up.frequency).not.toBe("weekly");
});
