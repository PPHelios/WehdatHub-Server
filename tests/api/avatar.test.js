// tests/api/avatar.test.js — a broker sets and removes their own profile photo; it never shows for another agency.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const sharp = require("sharp");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(() => closeHarness());

async function login(who) {
  const b = h.BROKERS[who];
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const res = await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: b.phone, code });
  return { Authorization: `Bearer ${res.body.token}` };
}
const png = () => sharp({ create: { width: 800, height: 600, channels: 3, background: "#c33" } }).png().toBuffer();
const put = (auth, buf, type = "image/png") => request(h.app.app).put("/api/v1/me/avatar").set(auth).attach("photo", buf, { filename: "a.png", contentType: type });

test("upload, show on /me, then delete", async () => {
  const auth = await login("broker");
  const up = await put(auth, await png());
  expect(up.status).toBe(200);
  expect(up.body.avatarUrl).toMatch(/avatars\/.+-\d+\.jpg$/);
  const path = (await h.pool.query("SELECT avatar_path FROM brokers WHERE id = $1", [h.BROKERS.broker.id])).rows[0].avatar_path;
  expect(path).toBe(`avatars/${h.BROKERS.broker.agency_id}/${h.BROKERS.broker.id}-${path.match(/-(\d+)\.jpg$/)[1]}.jpg`);
  const meta = await sharp(h.Storage.objects.get(path)).metadata();
  expect([meta.width, meta.height, meta.format]).toEqual([512, 512, "jpeg"]);
  expect((await request(h.app.app).get("/api/v1/me").set(auth)).body.broker.avatarUrl).toBe(up.body.avatarUrl);
  const del = await request(h.app.app).delete("/api/v1/me/avatar").set(auth);
  expect(del.body).toEqual({ avatarUrl: null });
  expect(h.Storage.objects.has(path)).toBe(false);
  expect((await request(h.app.app).get("/api/v1/me").set(auth)).body.broker.avatarUrl).toBeNull();
});

test("wrong type, too large, missing and broken images are refused", async () => {
  const auth = await login("broker");
  expect((await put(auth, Buffer.from("GIF89a"), "image/gif")).status).toBe(415);
  expect((await put(auth, Buffer.alloc(2 * 1024 * 1024 + 10), "image/png")).status).toBe(413);
  expect((await put(auth, Buffer.from("not an image"), "image/png")).status).toBe(422);
  expect((await request(h.app.app).put("/api/v1/me/avatar").set(auth)).status).toBe(422);
  expect((await request(h.app.app).put("/api/v1/me/avatar").attach("photo", await png(), { filename: "a.png", contentType: "image/png" })).status).toBe(401);
});

test("another agency does not see the photo and cannot change it", async () => {
  const auth = await login("broker");
  const rival = await login("rival");
  const up = await put(auth, await png());
  expect((await request(h.app.app).get("/api/v1/me").set(rival)).body.broker.avatarUrl).toBeNull();
  await request(h.app.app).delete("/api/v1/me/avatar").set(rival);
  expect((await request(h.app.app).get("/api/v1/me").set(auth)).body.broker.avatarUrl).toBe(up.body.avatarUrl);
});

test("team board and assistant cards carry avatarUrl, scoped to the agency", async () => {
  const { withAvatars } = require("../../services/assistantQuery");
  const a = h.BROKERS.colleague;
  const rival = h.BROKERS.rival;
  await h.pool.query("UPDATE brokers SET avatar_path = 'avatars/x.jpg' WHERE id IN ($1, $2)", [a.id, rival.id]);
  await h.seedBroker("manager");
  const team = (await request(h.app.app).get("/api/v1/team").set(await login("manager"))).body.items;
  expect(team.find((m) => m.id === a.id).avatarUrl).toMatch(/avatars\/x\.jpg$/);
  expect(team.find((m) => m.id === h.BROKERS.manager.id).avatarUrl).toBeNull();
  const answer = { cards: [{ kind: "stuck_leads", items: [{ assigneeId: a.id }, { assigneeId: rival.id }, { assigneeId: null }], recommendedBrokers: [{ id: a.id }] }, { kind: "bar_breakdown", rows: [{ key: a.id }, { key: "Name" }] }] };
  await withAvatars(h.pool, { agency_id: a.agency_id }, answer);
  const [leads, bars] = answer.cards;
  expect(leads.items.map((i) => i.avatarUrl)).toEqual([expect.stringMatching(/x\.jpg$/), null, undefined]);
  expect(leads.recommendedBrokers[0].avatarUrl).toMatch(/x\.jpg$/);
  expect(bars.rows[0].avatarUrl).toMatch(/x\.jpg$/);
  expect(bars.rows[1].avatarUrl).toBeUndefined();
});
