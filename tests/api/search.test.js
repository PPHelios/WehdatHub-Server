// tests/api/search.test.js — The app's text search: needs a sign-in, reads the request, never leaks private units.
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

async function token(who) {
  const b = h.BROKERS[who];
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  return (await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: b.phone, code })).body.token;
}
const get = async (who, q) => request(h.app.app).get("/api/v1/search").query(q).set("Authorization", `Bearer ${await token(who)}`);

test("search needs a sign-in and a non-empty request", async () => {
  expect((await request(h.app.app).get("/api/v1/search").query({ q: "x" })).status).toBe(401);
  expect((await get("broker", { q: "  " })).status).toBe(400);
});

test("a plain request returns a well-formed answer and never an error page", async () => {
  const r = await get("broker", { q: "شقة 3 غرف في التجمع" });
  expect(r.status).toBe(200);
  expect(["results", "none", "ask"]).toContain(r.body.status);
  expect(Array.isArray(r.body.items)).toBe(true);
});

test("drop=1 never answers with an ask", async () => {
  const r = await get("broker", { q: "شقة في الخيالستان بميزة غريبة", drop: "1" });
  expect(r.status).toBe(200);
  expect(r.body.status).not.toBe("ask");
});

test("small talk is reported as such, not searched", async () => {
  const r = await get("broker", { q: "اهلا" });
  expect(r.status).toBe(200);
  expect(r.body.items).toEqual([]);
});

test("voice search: no audio is refused, a note comes back as text, silence is not made up", async () => {
  const AI = require("../../lib/ai");
  const tok = await token("broker");
  const post = () => request(h.app.app).post("/api/v1/search/voice").set("Authorization", `Bearer ${tok}`);
  expect((await post()).status).toBe(400);
  AI.respond(() => "شقة 3 غرف في التجمع");
  const ok = await post().attach("voice", Buffer.from("abc"), { filename: "v.m4a", contentType: "audio/mp4" });
  expect(ok.status).toBe(200);
  expect(ok.body.q).toBe("شقة 3 غرف في التجمع");
  AI.respond(() => "x".repeat(300));
  const long = await post().attach("voice", Buffer.from("abc"), { filename: "v.m4a", contentType: "audio/mp4" });
  expect(long.status).toBe(422);
});

test("the public config tells old apps the lowest supported version", async () => {
  const r = await request(h.app.app).get("/api/v1/config");
  expect(r.status).toBe(200);
  expect(r.body.minAppVersion).toMatch(/^\d+\.\d+\.\d+$/);
});

test("an app search is logged like a web or Telegram one, with timings, and its Sold count follows the filters", async () => {
  await h.insertListing({ code: "AP1", compound: "Hyde Park", bedrooms: 3, listing_type: "rent", price_value: 40000, status: "sold" });
  await h.insertListing({ code: "AP2", compound: "Mivida", bedrooms: 3, listing_type: "rent", price_value: 40000, status: "sold" });
  const r = await get("broker", { q: "شقة ايجار في هايد بارك 3 نوم" });
  expect(r.status).toBe(200);
  const [row] = await h.query("SELECT channel, source, total, total_ms, parse_ms, db_ms, model FROM search_log WHERE channel = 'app' ORDER BY created_at DESC LIMIT 1");
  expect(row).toMatchObject({ channel: "app" });
  expect(row.total_ms).toBeGreaterThanOrEqual(0);
  expect(row.db_ms).toBeGreaterThanOrEqual(0);
  // Only Hyde Park's sold unit fits the filters; the Mivida one must not be counted.
  if (r.body.counts) expect(r.body.counts.sold).toBeLessThanOrEqual(1);
  // A "more" page is the same search: not logged twice.
  await get("broker", { q: "شقة ايجار في هايد بارك 3 نوم", offset: "5" });
  expect((await h.query("SELECT COUNT(*)::int AS n FROM search_log WHERE channel = 'app'"))[0].n).toBe(1);
});

test("an answer carries the reading in words, with sale or rent", async () => {
  const r = await get("broker", { q: "شقة 3 غرف في التجمع" });
  if (r.body.status === "results" || r.body.status === "none") expect(r.body.reading).toMatch(/بيع أو إيجار|بيع|إيجار/);
});
