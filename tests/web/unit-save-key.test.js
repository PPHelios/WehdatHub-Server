// tests/web/unit-save-key.test.js — One save key per unit save: a repeated try never saves twice, the "is it saved?" check
// finds the first result, a refused save leaves no key behind, and the browser's own timing report is stored.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const WebAuth = require("../../lib/webAuth");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const FIELDS = { listing_type: "sale", market: "resale", property_type: "apartment", compound: "Hyde Park", price_value: "9 مليون", area_value: "150", bedrooms: "3", bathrooms: "2", finishing: "fully_finished", force: "1", owner_name: "Mr Owner", owner_phone: "01012345678" };
const post = (agent, csrf, fields, path = "/app/units/new") => {
  let r = agent.post(path).field("_csrf", csrf);
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return r;
};
const codeOf = (res) => decodeURIComponent(res.headers.location.match(/units\/([^?]+)/)[1]);
const count = async () => (await h.query("SELECT count(*)::int AS n FROM listings"))[0].n;

test("the form carries a fresh save key each time it opens", async () => {
  const { agent } = await signIn(h, "broker");
  const a = (await agent.get("/app/units/new?lang=en")).text.match(/name="save_key" value="([\w-]{8,64})"/);
  const b = (await agent.get("/app/units/new?lang=en")).text.match(/name="save_key" value="([\w-]{8,64})"/);
  expect(a).toBeTruthy();
  expect(a[1]).not.toBe(b[1]);
});

test("a save sent twice with the same key saves one unit and the check finds it", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  const before = await count();
  const first = await post(agent, csrf, { ...FIELDS, save_key: "key-one-abcdef" });
  expect(first.status).toBe(303);
  const code = codeOf(first);
  const again = await post(agent, csrf, { ...FIELDS, save_key: "key-one-abcdef" });
  expect(again.status).toBe(303);
  expect(codeOf(again)).toBe(code);
  expect(await count()).toBe(before + 1);
  const saved = await agent.get("/app/units/save-status?key=key-one-abcdef");
  expect(saved.body).toEqual({ saved: true, code });
  expect((await agent.get("/app/units/save-status?key=never-saved-x1")).body).toEqual({ saved: false });
  // The same key from a bad value is just "not saved".
  expect((await agent.get("/app/units/save-status?key=%27%3B--")).body).toEqual({ saved: false });
});

test("a refused save leaves no key behind: the fixed form saves with the same key", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  const bad = await post(agent, csrf, { ...FIELDS, price_value: "", save_key: "key-two-abcdef" });
  expect(bad.status).toBe(422);
  expect((await agent.get("/app/units/save-status?key=key-two-abcdef")).body).toEqual({ saved: false });
  const ok = await post(agent, csrf, { ...FIELDS, save_key: "key-two-abcdef" });
  expect(ok.status).toBe(303);
  expect((await agent.get("/app/units/save-status?key=key-two-abcdef")).body.saved).toBe(true);
});

test("a save without a key still works (old pages, scripts)", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  const r = await post(agent, csrf, FIELDS);
  expect(r.status).toBe(303);
});

test("an edit sent twice with the same key changes once; the repeat is not a conflict", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  const created = await post(agent, csrf, { ...FIELDS, save_key: "key-three-abcde" });
  const code = codeOf(created);
  const version = (await h.query("SELECT version FROM listings WHERE code = $1", [code]))[0].version;
  const edit = (key) => post(agent, csrf, { ...FIELDS, price_value: "8 مليون", code, version: String(version), save_key: key }, `/app/units/${encodeURIComponent(code)}/edit`);
  const first = await edit("key-edit-abcdef");
  expect(first.status).toBe(303);
  const again = await edit("key-edit-abcdef");
  expect(again.status).toBe(303);
  expect(again.headers.location).toContain(encodeURIComponent(code));
  const row = (await h.query("SELECT version FROM listings WHERE code = $1", [code]))[0];
  expect(Number(row.version)).toBe(Number(version) + 1);
});

test("the browser's timing report is stored, with no unit content", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  const r = await agent.post("/app/units/save-report").set("X-CSRF-Token", csrf).send({ outcome: "timeout", ms: 61234, edit: false, photos: 12 });
  expect(r.status).toBe(204);
  const rows = await h.query("SELECT status, error_code, total_duration_ms, metadata FROM operation_logs WHERE operation_type = 'web_unit_save_client'");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "error", error_code: "timeout", total_duration_ms: 61234 });
  expect(rows[0].metadata).toEqual({ outcome: "timeout", edit: false, photos: 12 });
  // An unknown outcome is ignored.
  await agent.post("/app/units/save-report").set("X-CSRF-Token", csrf).send({ outcome: "whatever", ms: 1 });
  expect(await h.query("SELECT 1 FROM operation_logs WHERE operation_type = 'web_unit_save_client'")).toHaveLength(1);
});

test("the unit's own save time is logged (total, photo upload and database)", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  const r = await post(agent, csrf, { ...FIELDS, save_key: "key-time-abcdef" });
  const code = codeOf(r);
  const log = (await h.query("SELECT total_duration_ms, db_ms, metadata FROM operation_logs WHERE operation_type = 'web_unit_create' AND listing_code = $1", [code]))[0];
  expect(log.total_duration_ms).toBeGreaterThan(0);
  expect(log.metadata.save_key).toBe(true);
});

const api = () => request(h.app.app);
async function apiLogin(who) {
  const b = h.BROKERS[who];
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const res = await api().post("/api/v1/auth/code/verify").send({ phone: b.phone, code });
  return { Authorization: `Bearer ${res.body.token}` };
}

test("the app's create and check use the same key", async () => {
  const auth = await apiLogin("broker");
  const fields = JSON.stringify({ ...FIELDS, owner_name_from_phone: "1" });
  const first = await api().post("/api/v1/units").set(auth).field("fields", fields).field("save_key", "key-app-abcdefg");
  expect(first.status).toBe(201);
  const again = await api().post("/api/v1/units").set(auth).field("fields", fields).field("save_key", "key-app-abcdefg");
  expect(again.status).toBe(201);
  expect(again.body).toMatchObject({ code: first.body.code, repeat: true });
  const st = await api().get("/api/v1/units/save-status?key=key-app-abcdefg").set(auth);
  expect(st.body).toEqual({ saved: true, code: first.body.code });
  expect((await api().get("/api/v1/units/save-status?key=key-app-other12").set(auth)).body).toEqual({ saved: false });
});
