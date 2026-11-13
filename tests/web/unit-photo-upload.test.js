// tests/web/unit-photo-upload.test.js — Photos that go straight to storage: upload links, saving a unit with photo keys,
// refusals (missing, someone else's, already used), the daily cleanup, the storage address in the CSP, and the app's endpoints.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const WebAuth = require("../../lib/webAuth");
const Fake = require("../harness/fake-supabase");
const Uploads = require("../../lib/unitUploads");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
  Fake.reset();
});
afterAll(closeHarness);

const FIELDS = { listing_type: "sale", market: "resale", property_type: "apartment", compound: "Hyde Park", price_value: "9 مليون", area_value: "150", bedrooms: "3", bathrooms: "2", finishing: "fully_finished", force: "1", owner_name: "Mr Owner", owner_phone: "01012345678" };
const post = (agent, csrf, fields, keys = [], path = "/app/units/new") => {
  let r = agent.post(path).field("_csrf", csrf);
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  for (const k of keys) r = r.field("photo_keys", k);
  return r;
};
const codeOf = (res) => decodeURIComponent(res.headers.location.match(/units\/([^?]+)/)[1]);
const sign = (agent, csrf, count) => agent.post("/app/units/photo-upload").set("X-CSRF-Token", csrf).send({ count });
// A phone puts the bytes straight in storage; here the fake stands in for that.
const putAll = async (uploads) => {
  for (const u of uploads) {
    const row = (await h.query("SELECT path FROM unit_photo_uploads WHERE key = $1", [u.key]))[0];
    Fake.objects.set(row.path, Buffer.from("jpeg-bytes"));
  }
};

test("an upload link per photo, each tied to the broker", async () => {
  const { agent, csrf, broker } = await signIn(h, "broker");
  const r = await sign(agent, csrf, 3);
  expect(r.status).toBe(200);
  expect(r.body.uploads).toHaveLength(3);
  expect(r.body.uploads[0]).toEqual(expect.objectContaining({ key: expect.stringMatching(/^[\w-]{8,64}$/), upload_url: expect.stringContaining("storage.test/upload/sign/listings/"), thumb_upload_url: expect.stringContaining("thumbs/") }));
  const rows = await h.query("SELECT broker_id, agency_id, attached_at FROM unit_photo_uploads");
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatchObject({ broker_id: broker.id, attached_at: null });
  expect((await sign(agent, csrf, 99)).body.uploads).toHaveLength(15); // capped at the unit's limit
});

test("a unit saved with photo keys gets those photos, in order, and the keys are used up", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  const { uploads } = (await sign(agent, csrf, 3)).body;
  await putAll(uploads);
  const keys = [uploads[2].key, uploads[0].key, uploads[1].key];
  const res = await post(agent, csrf, { ...FIELDS, save_key: "dir-save-abcdef" }, keys);
  expect(res.status).toBe(303);
  const code = codeOf(res);
  const imgs = await h.query("SELECT li.url FROM listing_images li JOIN listings l ON l.id = li.listing_id WHERE l.code = $1 ORDER BY li.position", [code]);
  expect(imgs).toHaveLength(3);
  const paths = await h.query("SELECT key, path FROM unit_photo_uploads");
  const pathOf = Object.fromEntries(paths.map((r) => [r.key, r.path]));
  expect(imgs.map((i) => i.url)).toEqual(keys.map((k) => pathOf[k]));
  expect((await h.query("SELECT count(*)::int AS n FROM unit_photo_uploads WHERE attached_at IS NOT NULL"))[0].n).toBe(3);
  // The same photos cannot be used for a second unit.
  const again = await post(agent, csrf, FIELDS, keys);
  expect(again.status).toBe(422);
});

test("a photo that never reached storage refuses the save and creates nothing", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  const { uploads } = (await sign(agent, csrf, 2)).body;
  await putAll([uploads[0]]); // the second never finished
  const before = (await h.query("SELECT count(*)::int AS n FROM listings"))[0].n;
  const res = await post(agent, csrf, FIELDS, uploads.map((u) => u.key));
  expect(res.status).toBe(422);
  expect((await h.query("SELECT count(*)::int AS n FROM listings"))[0].n).toBe(before);
  expect((await h.query("SELECT count(*)::int AS n FROM unit_photo_uploads WHERE attached_at IS NOT NULL"))[0].n).toBe(0);
});

test("another broker's photo key is refused", async () => {
  const mine = await signIn(h, "broker");
  const theirs = await signIn(h, "colleague");
  const { uploads } = (await sign(theirs.agent, theirs.csrf, 1)).body;
  await putAll(uploads);
  const res = await post(mine.agent, mine.csrf, FIELDS, [uploads[0].key]);
  expect(res.status).toBe(422);
});

test("photos can be added to an existing unit by key", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  const created = await post(agent, csrf, FIELDS);
  const code = codeOf(created);
  const version = (await h.query("SELECT version FROM listings WHERE code = $1", [code]))[0].version;
  const { uploads } = (await sign(agent, csrf, 2)).body;
  await putAll(uploads);
  const res = await post(agent, csrf, { ...FIELDS, code, version: String(version) }, uploads.map((u) => u.key), `/app/units/${encodeURIComponent(code)}/edit`);
  expect(res.status).toBe(303);
  const n = (await h.query("SELECT count(*)::int AS n FROM listing_images li JOIN listings l ON l.id = li.listing_id WHERE l.code = $1", [code]))[0].n;
  expect(n).toBe(2);
});

test("the draft check returns only photos still good, with their links", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  const { uploads } = (await sign(agent, csrf, 2)).body;
  await putAll([uploads[0]]);
  const r = await agent.post("/app/units/photo-upload/check").set("X-CSRF-Token", csrf).send({ keys: uploads.map((u) => u.key) });
  expect(r.body.ready).toHaveLength(1);
  expect(r.body.ready[0].key).toBe(uploads[0].key);
  expect(r.body.ready[0].url).toContain("storage.test");
});

test("the daily cleanup removes unused photos after 24 hours and forgets used rows after 7 days", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  const { uploads } = (await sign(agent, csrf, 3)).body;
  await putAll(uploads);
  const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  await h.query("UPDATE unit_photo_uploads SET created_at = $1 WHERE key = $2", [old, uploads[0].key]);
  await h.query("UPDATE unit_photo_uploads SET created_at = $1, attached_at = $2 WHERE key = $3", [old, new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString(), uploads[1].key]);
  const path0 = (await h.query("SELECT path FROM unit_photo_uploads WHERE key = $1", [uploads[0].key]))[0].path;
  const out = await Uploads.purgeOld(h.pool);
  expect(out).toEqual({ uploadsPurged: 1, uploadsForgotten: 1 });
  expect(Fake.objects.has(path0)).toBe(false);
  expect((await h.query("SELECT key FROM unit_photo_uploads")).map((r) => r.key)).toEqual([uploads[2].key]);
});

test("the page may talk to the storage address (CSP) only when it is set", async () => {
  const { agent } = await signIn(h, "broker");
  const saved = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  const before = (await agent.get("/app/units/new")).headers["content-security-policy"];
  expect(before).toMatch(/connect-src 'self'(;|$)/);
  process.env.SUPABASE_URL = "https://abc.supabase.co";
  try {
    const during = (await agent.get("/app/units/new")).headers["content-security-policy"];
    expect(during).toMatch(/connect-src 'self' https:\/\/abc\.supabase\.co/);
  } finally {
    if (saved === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = saved;
  }
});

const api = () => request(h.app.app);
async function apiLogin(who) {
  const b = h.BROKERS[who];
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const res = await api().post("/api/v1/auth/code/verify").send({ phone: b.phone, code });
  return { Authorization: `Bearer ${res.body.token}` };
}

test("the app gets links, creates a unit with the keys, and a missing photo is a 422 with the key", async () => {
  const auth = await apiLogin("broker");
  const s = await api().post("/api/v1/units/photo-upload").set(auth).send({ count: 2 });
  expect(s.status).toBe(200);
  expect(s.body.expires_in).toBe(7200);
  const { uploads } = s.body;
  const fields = JSON.stringify({ ...FIELDS, owner_name_from_phone: "1" });
  const missing = await api().post("/api/v1/units").set(auth).field("fields", fields).field("photo_keys", JSON.stringify(uploads.map((u) => u.key)));
  expect(missing.status).toBe(422);
  expect(missing.body).toMatchObject({ error: "photo_missing" });
  expect(missing.body.keys).toHaveLength(2);
  await putAll(uploads);
  const ok = await api().post("/api/v1/units").set(auth).field("fields", fields).field("photo_keys", JSON.stringify(uploads.map((u) => u.key)));
  expect(ok.status).toBe(201);
  expect(ok.body.photos).toBe(2);
});
