// tests/api/chat-plan-endpoint.test.js — POST /units/chat-plan: what each WhatsApp post would do to the broker's inventory
// (new, update, unchanged, other_unit, older, invalid, forbidden), with a patch in the add-unit form's names that never carries
// market, is_ready, features, notes or the owner phone. Nothing is written.
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
  await h.approvePlaces([["hyde park", "Hyde Park", "هايد بارك"]]);
});
afterAll(() => closeHarness());

async function authFor(b) {
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const res = await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: b.phone, code });
  return { Authorization: `Bearer ${res.body.token}` };
}
const plan = (auth, posts) => request(h.app.app).post("/api/v1/units/chat-plan").set(auth).send({ posts });
const listing = (code) => h.query("SELECT * FROM listings WHERE code = $1", [code]).then((r) => r[0]);
const POST = (code, price, extra = "") => `Code ${code} Hyde Park apartment for sale 150m 3 bedrooms 3 bathrooms price: ${price} 01099998888 ${extra}`;

async function seed(code, fields = {}) {
  await h.insertListing({ code, compound: "هايد بارك", compound_en: "Hyde Park", price_value: 8500000, details: { owner_phone: "01012345678", notes: "keep me", clean_summary: "stored summary" }, ...fields });
}

test("a new unit, an invalid post and a code that is not stored", async () => {
  const auth = await authFor(h.BROKERS.broker);
  const res = await plan(auth, [{ id: "a", fields: { code: "ZZ1" }, text: POST("ZZ1", "9000000"), at: "2026-11-01T10:00:00Z" }, { id: "b", fields: {}, text: "hello nothing here" }]);
  expect(res.status).toBe(200);
  const [a, b] = res.body.posts;
  expect(a).toMatchObject({ id: "a", kind: "new", code: "ZZ1", existing: null, patch: {} });
  expect(b).toMatchObject({ id: "b", kind: "invalid", existing: null });
  expect(b.errors.length).toBeGreaterThan(0);
  expect(await listing("ZZ1")).toBeUndefined();
});

test("update: price changes in the form's names, both languages, no market/is_ready/feature/notes, stored owner phone kept", async () => {
  await seed("U1", { market: "resale", is_ready: true, feature_keys: ["garden"] });
  const before = await listing("U1");
  const auth = await authFor(h.BROKERS.broker);
  const res = await plan(auth, [{ id: 1, fields: { code: "U1" }, text: POST("U1", "8800000"), at: new Date(Date.now() + 60000).toISOString() }]);
  const p = res.body.posts[0];
  expect(p.kind).toBe("update");
  expect(p.existing).toMatchObject({ code: "U1", version: before.version });
  expect(p.patch).toMatchObject({ price_value: "8800000" });
  for (const k of ["market", "is_ready", "feature", "features_other", "notes", "clean_summary", "owner_phone", "code"]) expect(p.patch).not.toHaveProperty(k);
  const ch = p.changes.find((c) => c.field === "price_value");
  expect(ch).toMatchObject({ from_en: expect.any(String), to_en: expect.any(String), from_ar: expect.any(String), to_ar: expect.any(String) });
  expect(p.changes.some((c) => /notes|clean_summary|summary_en|owner_phone/.test(c.field))).toBe(false);
  const after = await listing("U1");
  expect(after.version).toBe(before.version);
  expect(after.details.owner_phone).toBe("01012345678");
});

test("unchanged: the post says what is stored", async () => {
  await seed("U2", { bathrooms: 3 });
  const auth = await authFor(h.BROKERS.broker);
  const res = await plan(auth, [{ id: 1, fields: { code: "U2" }, text: POST("U2", "8500000"), at: new Date(Date.now() + 60000).toISOString() }]);
  expect(res.body.posts[0]).toMatchObject({ kind: "unchanged", code: "U2", patch: {}, changes: [] });
});

test("older: the stored unit was updated after the post", async () => {
  await seed("U3");
  const auth = await authFor(h.BROKERS.broker);
  const res = await plan(auth, [{ id: 1, fields: { code: "U3" }, text: POST("U3", "8800000"), at: "2020-01-01T00:00:00Z" }]);
  expect(res.body.posts[0]).toMatchObject({ kind: "older", code: "U3", patch: {} });
});

test("other_unit: the code belongs to a different unit", async () => {
  await seed("U4");
  const auth = await authFor(h.BROKERS.broker);
  const res = await plan(auth, [{ id: 1, fields: { code: "U4" }, text: "Code U4 Hyde Park villa for sale 400m 5 bedrooms 5 bathrooms price: 30000000 01099998888", at: new Date(Date.now() + 60000).toISOString() }]);
  expect(res.body.posts[0]).toMatchObject({ kind: "other_unit", code: "U4", patch: {} });
  expect(res.body.posts[0].changes.map((c) => c.field)).toContain("price_value"); // what differs from the stored unit, for the card
});

test("forbidden: a colleague's unit", async () => {
  await seed("U5", { broker_id: h.BROKERS.colleague.id });
  const auth = await authFor(h.BROKERS.broker);
  const res = await plan(auth, [{ id: 1, fields: { code: "U5" }, text: POST("U5", "8800000"), at: new Date(Date.now() + 60000).toISOString() }]);
  expect(res.body.posts[0]).toMatchObject({ kind: "forbidden", patch: {} });
});

test("a unit with no stored owner phone takes the one in the post's own text", async () => {
  await seed("U6", { details: {} });
  const auth = await authFor(h.BROKERS.broker);
  const res = await plan(auth, [{ id: 1, fields: { code: "U6" }, text: POST("U6", "8800000"), at: new Date(Date.now() + 60000).toISOString() }]);
  expect(res.body.posts[0].kind).toBe("update");
  expect(res.body.posts[0].patch.owner_phone).toBe("01099998888");
});

test("needs a signed-in person; writes off is a 403; at most 60 posts are read", async () => {
  expect((await request(h.app.app).post("/api/v1/units/chat-plan").send({ posts: [] })).status).toBe(401);
  const auth = await authFor(h.BROKERS.broker);
  const many = Array.from({ length: 70 }, (_, i) => ({ id: i, fields: {}, text: "x" }));
  const res = await plan(auth, many);
  expect(res.body.posts).toHaveLength(60);
});
