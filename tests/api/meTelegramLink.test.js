// tests/api/meTelegramLink.test.js — app "connect Telegram" link, onboarding hasPhotos, lead assignee avatar.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const { resetConfig } = require("../../config");
const WebAuth = require("../../lib/webAuth");
const TgLink = require("../../lib/tgLink");

jest.setTimeout(90000);

let h;
let auth;
beforeAll(() => {
  process.env.TELEGRAM_BOT_USERNAME = "Wehdat_Hub_bot";
  resetConfig();
});
beforeEach(async () => {
  h = await createHarness();
  const b = h.BROKERS.broker;
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const res = await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: b.phone, code });
  auth = { Authorization: `Bearer ${res.body.token}` };
});
afterAll(() => closeHarness());

test("POST /me/telegram-link returns a start link that links the broker", async () => {
  const res = await request(h.app.app).post("/api/v1/me/telegram-link").set(auth);
  expect(res.status).toBe(200);
  const m = res.body.url.match(/^https:\/\/t\.me\/Wehdat_Hub_bot\?start=([A-Za-z0-9_-]{20,64})$/);
  expect(m).toBeTruthy();
  const linked = await TgLink.linkByToken(h.pool, m[1], { userId: 987001, chatId: 987001 });
  expect(linked.broker.id).toBe(h.BROKERS.broker.id);
  const me = await request(h.app.app).get("/api/v1/me").set(auth);
  expect(me.body.onboarding.telegramConnected).toBe(true);
  expect((await request(h.app.app).post("/api/v1/me/telegram-link")).status).toBe(401);
});

test("onboarding.hasPhotos turns true once the agency has a unit image", async () => {
  const b = h.BROKERS.broker;
  expect((await request(h.app.app).get("/api/v1/me").set(auth)).body.onboarding.hasPhotos).toBe(false);
  const [l] = await h.query(
    `INSERT INTO listings (agency_id, broker_id, code, listing_type, property_type, title, price_value, status)
     VALUES ($1, $2, 'P1', 'sale', 'apartment', 'P', 1000000, 'active') RETURNING id`,
    [b.agency_id, b.id]
  );
  await h.query("INSERT INTO listing_images (listing_id, agency_id, position, url) VALUES ($1, $2, 0, 'x.jpg')", [l.id, b.agency_id]);
  expect((await request(h.app.app).get("/api/v1/me").set(auth)).body.onboarding.hasPhotos).toBe(true);
});

test("GET /leads carries the assignee's avatarUrl", async () => {
  const b = h.BROKERS.broker;
  await h.query("UPDATE brokers SET avatar_path = $2 WHERE id = $1", [b.id, `avatars/${b.agency_id}/a.jpg`]);
  const made = await request(h.app.app).post("/api/v1/leads").set(auth).send({ phone1: "01011112222", name: "Lead One", kind: "buyer" });
  expect(made.status).toBe(201);
  const list = await request(h.app.app).get("/api/v1/leads").set(auth);
  const lead = list.body.items.find((l) => l.assigneeId === b.id);
  expect(lead.assigneeAvatarUrl).toMatch(/a\.jpg$/);
});
