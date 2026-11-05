// tests/web/soft-delete.test.js — Soft delete (migration 075): a deleted unit leaves search and every list, managers and the
// owner restore it for 10 days, and the purge keeps its reference facts and removes the row and photos after that.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const UnitDelete = require("../../services/unitDelete");
const Search = require("../../services/search");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const codesOn = (text) => [...text.matchAll(/data-code="([^"]+)"/g)].map((m) => m[1]).sort();
const statusOf = async (code) => (await h.query("SELECT status, deleted_at FROM listings WHERE code = $1", [code]))[0];

test("a broker deletes their unit: it leaves the list and search, and is kept for 10 days", async () => {
  const l = await h.insertListing({ broker_id: h.BROKERS.broker.id, code: "DL-1", property_type: "apartment", price_value: 4000000 });
  const b = await signIn(h, "broker");
  const r = await b.agent.post("/app/units/DL-1/delete").type("form").send({ _csrf: b.csrf });
  expect(r.status).toBe(303);
  expect(await statusOf("DL-1")).toMatchObject({ status: "deleted" });
  expect((await statusOf("DL-1")).deleted_at).not.toBeNull();
  expect(codesOn((await b.agent.get("/app/units?lang=en")).text)).not.toContain("DL-1");
  const res = await Search.runSearch(h.pool, h.AGENCY_A, { filters: { property_types: ["apartment"] } }, {});
  expect(res.rows.map((x) => x.code)).not.toContain("DL-1");
  expect(l.id).toBeDefined();
});

test("only managers and the owner see Recently deleted and restore; a broker gets the normal list", async () => {
  await h.insertListing({ broker_id: h.BROKERS.broker.id, code: "DL-2", status: "deleted", deleted_at: new Date().toISOString() });
  const b = await signIn(h, "broker");
  expect(b.agent).toBeDefined();
  expect(codesOn((await b.agent.get("/app/units?status=deleted&lang=en")).text)).not.toContain("DL-2");
  const a = await signIn(h, "admin");
  const page = (await a.agent.get("/app/units?status=deleted&lang=en")).text;
  expect([...page.matchAll(/data-deleted-code="([^"]+)"/g)].map((m) => m[1])).toEqual(["DL-2"]);
  expect(page).toMatch(/purged in 10 day/);
  expect((await b.agent.post("/app/units/DL-2/restore").type("form").send({ _csrf: b.csrf })).status).toBe(403);
});

test("a manager restores a deleted unit: it is available again", async () => {
  await h.insertListing({ broker_id: h.BROKERS.broker.id, code: "DL-3", status: "deleted", deleted_at: new Date().toISOString() });
  const a = await signIn(h, "admin");
  const r = await a.agent.post("/app/units/DL-3/restore").type("form").send({ _csrf: a.csrf });
  expect(r.status).toBe(303);
  expect(await statusOf("DL-3")).toMatchObject({ status: "active", deleted_at: null });
});

test("the purge removes a unit deleted over 10 days ago and keeps its reference facts; a newer deletion stays", async () => {
  const old = new Date(Date.now() - 11 * 24 * 3600 * 1000).toISOString();
  const recent = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
  await h.insertListing({ broker_id: h.BROKERS.broker.id, code: "OLD-1", status: "deleted", deleted_at: old, compound: "Hyde Park", price_value: 7500000, area_value: 180, bedrooms: 3 });
  await h.insertListing({ broker_id: h.BROKERS.broker.id, code: "NEW-1", status: "deleted", deleted_at: recent });
  const out = await UnitDelete.purgeDue(h.pool);
  expect(out.purged).toBe(1);
  expect(await h.query("SELECT code FROM listings WHERE code = 'OLD-1'")).toEqual([]);
  expect(await statusOf("NEW-1")).toMatchObject({ status: "deleted" });
  const ref = (await h.query("SELECT code, compound, price_value, area_value, bedrooms FROM unit_reference WHERE code = 'OLD-1'"))[0];
  expect(ref).toMatchObject({ code: "OLD-1", compound: "Hyde Park", bedrooms: 3 });
  expect(Number(ref.price_value)).toBe(7500000);
});

test("a restore after the 10 days is refused", async () => {
  const old = new Date(Date.now() - 11 * 24 * 3600 * 1000).toISOString();
  const l = await h.insertListing({ broker_id: h.BROKERS.broker.id, code: "OLD-2", status: "deleted", deleted_at: old });
  const a = await signIn(h, "admin");
  expect(await UnitDelete.restore(h.pool, a.broker, l.id)).toEqual({ error: "expired" });
});

test("a deleted unit cannot be changed by a bulk edit or a sold command, and deleting one twice says so", async () => {
  const l = await h.insertListing({ broker_id: h.BROKERS.broker.id, code: "DL-4" });
  const b = await signIn(h, "broker");
  await UnitDelete.softDelete(h.pool, b.broker, l.id);
  const again = await UnitDelete.softDelete(h.pool, b.broker, l.id);
  expect(again).toEqual({ error: "already_deleted" });
  const bulk = require("../../services/bulk");
  const out = await bulk.bulkUpdate(h.pool, b.broker, { codes: ["DL-4"], action: "sold" });
  expect(out.updated).toEqual([]);
  expect(await statusOf("DL-4")).toMatchObject({ status: "deleted" });
});
