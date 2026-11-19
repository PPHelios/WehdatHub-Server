// tests/api/chat-decisions.test.js — GET/PUT/DELETE /units/chat-decisions: what the agency decided about each post of a chat,
// shared by every broker of the agency, never across agencies.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");
const Decisions = require("../../services/chatDecisions");

jest.setTimeout(90000);

let h;
beforeEach(async () => { h = await createHarness(); });
afterAll(() => closeHarness());

async function authFor(b) {
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const res = await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: b.phone, code });
  return { Authorization: `Bearer ${res.body.token}` };
}
const CHAT = "0123456789abcdef";
const url = "/api/v1/units/chat-decisions";

test("PUT stores, GET lists with last_import_at, a colleague of the agency sees the same", async () => {
  const a = await authFor(h.BROKERS.broker);
  const empty = await request(h.app.app).get(`${url}?chat_fp=${CHAT}`).set(a);
  expect(empty.status).toBe(200);
  expect(empty.body).toEqual({ decisions: {}, last_import_at: null });
  const put = await request(h.app.app).put(url).set(a).send({ chat_fp: CHAT, items: [{ post_fp: "abc1", outcome: "saved" }, { post_fp: "abc2", outcome: "discarded" }, { post_fp: "abc3", outcome: "unchanged" }, { post_fp: "bad post!", outcome: "saved" }, { post_fp: "abc4", outcome: "nope" }] });
  expect(put.body).toEqual({ ok: true, stored: 3 });
  const b = await authFor(h.BROKERS.colleague);
  const got = await request(h.app.app).get(`${url}?chat_fp=${CHAT}`).set(b);
  expect(Object.keys(got.body.decisions).sort()).toEqual(["abc1", "abc2", "abc3"]);
  expect(got.body.decisions.abc2).toMatchObject({ outcome: "discarded", at: expect.any(String) });
  expect(got.body.last_import_at).toEqual(got.body.decisions.abc1.at);
  // The same post again takes the latest outcome.
  await request(h.app.app).put(url).set(a).send({ chat_fp: CHAT, items: [{ post_fp: "abc2", outcome: "saved" }] });
  expect((await request(h.app.app).get(`${url}?chat_fp=${CHAT}`).set(a)).body.decisions.abc2.outcome).toBe("saved");
});

test("DELETE restores given posts, or forgets the whole chat; another chat is untouched", async () => {
  const a = await authFor(h.BROKERS.broker);
  const other = "fedcba9876543210";
  await request(h.app.app).put(url).set(a).send({ chat_fp: CHAT, items: [{ post_fp: "p1", outcome: "discarded" }, { post_fp: "p2", outcome: "discarded" }] });
  await request(h.app.app).put(url).set(a).send({ chat_fp: other, items: [{ post_fp: "p1", outcome: "saved" }] });
  const one = await request(h.app.app).delete(url).set(a).send({ chat_fp: CHAT, post_fps: ["p1"] });
  expect(one.body).toEqual({ ok: true, removed: 1 });
  expect(Object.keys((await request(h.app.app).get(`${url}?chat_fp=${CHAT}`).set(a)).body.decisions)).toEqual(["p2"]);
  const all = await request(h.app.app).delete(url).set(a).send({ chat_fp: CHAT });
  expect(all.body.removed).toBe(1);
  expect((await request(h.app.app).get(`${url}?chat_fp=${CHAT}`).set(a)).body.decisions).toEqual({});
  expect(Object.keys((await request(h.app.app).get(`${url}?chat_fp=${other}`).set(a)).body.decisions)).toEqual(["p1"]);
});

test("bad input: chat_fp shape, more than 200 items, signed out", async () => {
  const a = await authFor(h.BROKERS.broker);
  expect((await request(h.app.app).get(`${url}?chat_fp=zzz`).set(a)).status).toBe(400);
  expect((await request(h.app.app).put(url).set(a).send({ chat_fp: "nope", items: [] })).status).toBe(400);
  const many = Array.from({ length: 201 }, (_, i) => ({ post_fp: `p${i}`, outcome: "saved" }));
  expect((await request(h.app.app).put(url).set(a).send({ chat_fp: CHAT, items: many })).status).toBe(413);
  expect((await request(h.app.app).get(`${url}?chat_fp=${CHAT}`)).status).toBe(401);
});

test("decisions never cross agencies", async () => {
  await h.seedBroker("owner").catch(() => {});
  const a = await authFor(h.BROKERS.broker);
  await request(h.app.app).put(url).set(a).send({ chat_fp: CHAT, items: [{ post_fp: "p1", outcome: "saved" }] });
  const other = Object.values(h.BROKERS).find((b) => b.agency_id !== h.BROKERS.broker.agency_id);
  if (other) {
    if (other.lazy) await h.seedBroker(Object.keys(h.BROKERS).find((k) => h.BROKERS[k] === other));
    const o = await authFor(other);
    expect((await request(h.app.app).get(`${url}?chat_fp=${CHAT}`).set(o)).body.decisions).toEqual({});
  }
});

test("the service keeps at most 5000 per chat, dropping the oldest", async () => {
  const agency = h.BROKERS.broker.agency_id;
  const rows = Array.from({ length: 5003 }, (_, i) => i);
  await h.pool.query(
    `INSERT INTO chat_import_decisions (agency_id, chat_fp, post_fp, outcome, updated_at) SELECT $1, $2, 'q' || i, 'saved', NOW() - (i || ' seconds')::interval FROM unnest($3::int[]) AS i`,
    [agency, CHAT, rows]
  );
  await Decisions.record(h.pool, agency, null, CHAT, [{ post_fp: "fresh", outcome: "discarded" }]);
  const n = (await h.query("SELECT count(*)::int AS n FROM chat_import_decisions WHERE chat_fp = $1", [CHAT]))[0].n;
  expect(n).toBe(5000);
  const { decisions } = await Decisions.list(h.pool, agency, CHAT);
  expect(decisions.fresh.outcome).toBe("discarded");
  expect(decisions.q0).toBeDefined();
  expect(decisions.q5002).toBeUndefined();
});
