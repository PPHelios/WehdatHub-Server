// tests/api/unitEdit.test.js — Editing a unit from the app, compound suggestions, the stale filter, access requests and
// the client link's recipient.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");
const Rights = require("../../services/unitRights");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(() => closeHarness());

const api = () => request(h.app.app);
async function login(who) {
  if (h.BROKERS[who].lazy) await h.seedBroker(who);
  const b = h.BROKERS[who];
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const res = await api().post("/api/v1/auth/code/verify").send({ phone: b.phone, code });
  return { Authorization: `Bearer ${res.body.token}` };
}
const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];

async function ownUnit() {
  await h.insertListing({ code: "A-1", compound: "Mivida", price_value: 9e6, bedrooms: 3 });
  await h.query(`UPDATE listings SET details = jsonb_build_object('owner_name', 'Owner Ali', 'owner_phone', '01012345678') WHERE code = 'A-1' AND agency_id = $1`, [h.BROKERS.broker.agency_id]);
}

test("the owner of a unit opens its fields and saves a change; a stale version is a 409", async () => {
  await ownUnit();
  const auth = await login("broker");
  const open = await api().get("/api/v1/units/A-1/edit").set(auth);
  expect(open.status).toBe(200);
  expect(open.body.fields.compound).toBe("Mivida");
  const saved = await api().post("/api/v1/units/A-1/edit").set(auth).send({ version: open.body.version, fields: { ...open.body.fields, price_value: "8500000" } });
  expect(saved.status).toBe(200);
  expect(saved.body.version).toBeGreaterThan(open.body.version);
  const price = (await h.query("SELECT price_value FROM listings WHERE code = 'A-1' AND agency_id = $1", [h.BROKERS.broker.agency_id]))[0].price_value;
  expect(Number(price)).toBe(8500000);
  const stale = await api().post("/api/v1/units/A-1/edit").set(auth).send({ version: open.body.version, fields: { ...open.body.fields, price_value: "8000000" } });
  expect(stale.status).toBe(409);
});

test("a colleague cannot edit the unit, but data entry can; the broker switch blocks brokers only", async () => {
  await ownUnit();
  expect((await api().get("/api/v1/units/A-1/edit").set(await login("colleague"))).status).toBe(403);
  await h.query("UPDATE brokers SET role = 'data_entry' WHERE id = $1", [h.BROKERS.colleague.id]);
  const entry = await login("colleague");
  const open = await api().get("/api/v1/units/A-1/edit").set(entry);
  expect(open.status).toBe(200);
  await h.seedBroker("owner");
  await Rights.setBrokersMayWrite(h.pool, await row("owner"), false);
  expect((await api().get("/api/v1/units/A-1/edit").set(entry)).status).toBe(200);
  expect((await api().get("/api/v1/units/A-1/edit").set(await login("broker"))).status).toBe(403);
});

test("compound suggestions and the stale filter", async () => {
  await h.insertListing({ code: "A-1", compound: "Mivida" });
  await h.insertListing({ code: "A-2", compound: "Mivida" });
  await h.insertListing({ code: "A-3", compound: "Hyde Park" });
  // A trigger stamps updated_at on every update, so it is switched off for the one backdating statement.
  await h.query("ALTER TABLE listings DISABLE TRIGGER trg_update_listings_timestamp");
  await h.query("UPDATE listings SET updated_at = now() - interval '40 days' WHERE code = 'A-3' AND agency_id = $1", [h.BROKERS.broker.agency_id]);
  await h.query("ALTER TABLE listings ENABLE TRIGGER trg_update_listings_timestamp");
  const auth = await login("broker");
  const sug = await api().get("/api/v1/units/compounds?q=ivi").set(auth);
  expect(sug.body.items).toEqual([{ name: "Mivida", n: 2 }]);
  const stale = await api().get("/api/v1/units?staleDays=30").set(auth);
  expect(stale.body.items.map((u) => u.code)).toEqual(["A-3"]);
});

test("a hidden contact says how to ask, and the ask is remembered", async () => {
  await ownUnit();
  const colleague = await login("colleague");
  const first = await api().get("/api/v1/units/A-1/contact").set(colleague);
  expect(first.status).toBe(403);
  expect(first.body.access).toBe("ask");
  expect((await api().post("/api/v1/units/A-1/access-request").set(colleague).send({})).body.access).toBe("pending");
  expect((await api().get("/api/v1/units/A-1/contact").set(colleague)).body.access).toBe("pending");
});

test("the client link can go to a lead or a number, and a bad recipient is refused", async () => {
  await ownUnit();
  const auth = await login("broker");
  const made = await api().post("/api/v1/leads").set(auth).send({ phone1: "01011112222", name: "Lead One", kind: "buyer" });
  const ref = made.body.lead.ref;
  const toLead = await api().post("/api/v1/units/A-1/share-link").set(auth).send({ to: ref });
  expect(toLead.status).toBe(200);
  expect(toLead.body.leadLinked).toBe(true);
  const toNumber = await api().post("/api/v1/units/A-1/share-link").set(auth).send({ to: "01099998888" });
  expect(toNumber.body.recipientPhone).toBeTruthy();
  expect((await api().post("/api/v1/units/A-1/share-link").set(auth).send({ to: "123" })).status).toBe(422);
  expect((await api().post("/api/v1/units/A-1/share-link").set(auth).send({})).status).toBe(200);
});

test("the unit page says whether this person can edit it", async () => {
  await ownUnit();
  expect((await api().get("/api/v1/units/A-1").set(await login("broker"))).body.canEdit).toBe(true);
  expect((await api().get("/api/v1/units/A-1").set(await login("colleague"))).body.canEdit).toBe(false);
});

test("status, delete and restore from the app: own unit only, deleted units cannot change status", async () => {
  await ownUnit();
  const auth = await login("broker");
  expect((await api().post("/api/v1/units/A-1/status").set(auth).send({ status: "wat" })).status).toBe(422);
  expect((await api().post("/api/v1/units/A-1/status").set(auth).send({ status: "sold" })).status).toBe(200);
  expect((await h.query("SELECT status FROM listings WHERE code = 'A-1' AND agency_id = $1", [h.BROKERS.broker.agency_id]))[0].status).toBe("sold");
  expect((await api().post("/api/v1/units/A-1/delete").set(auth)).status).toBe(200);
  expect((await api().post("/api/v1/units/A-1/status").set(auth).send({ status: "active" })).status).toBe(422);
  expect((await api().post("/api/v1/units/A-1/restore").set(auth)).status).toBe(403);
  await h.seedBroker("manager");
  expect((await api().post("/api/v1/units/A-1/restore").set(await login("manager"))).status).toBe(200);
  const col = await login("colleague");
  expect((await api().post("/api/v1/units/A-1/status").set(col).send({ status: "archived" })).status).toBe(403);
});

test("lease, private details and project link from the app follow the same rules", async () => {
  await h.insertListing({ code: "R-1", listing_type: "rent", compound: "Mivida", price_value: 30000 });
  const auth = await login("manager");
  expect((await api().get("/api/v1/units/R-1/lease").set(auth)).body.lease).toBeNull();
  const bad = await api().post("/api/v1/units/R-1/lease").set(auth).send({ startDate: "nope", months: 12 });
  expect(bad.status).toBe(422);
  const ok = await api().post("/api/v1/units/R-1/lease").set(auth).send({ startDate: "2026-01-01", months: 12, rent: 30000, tenantName: "Ali" });
  expect(ok.status).toBe(200);
  expect((await api().get("/api/v1/units/R-1/lease").set(auth)).body.lease.months).toBe(12);
  expect((await api().post("/api/v1/units/R-1/lease").set(auth).send({ remove: true })).status).toBe(200);
  expect((await api().post("/api/v1/units/R-1/private").set(auth).send({ unitNo: "12", address: "Street 9" })).status).toBe(200);
  expect((await api().post("/api/v1/units/R-1/private").set(auth).send({ pin: "not a pin" })).status).toBe(422);
  expect((await api().post("/api/v1/units/R-1/lease").set(await login("colleague")).send({ startDate: "2026-01-01", months: 12 })).status).toBe(403);
});

test("renaming a unit's code in the edit form: a free code is saved, a code another unit uses is a 409 code_used", async () => {
  await ownUnit();
  await h.insertListing({ code: "B-2", compound: "Mivida", price_value: 5e6, bedrooms: 2 });
  const auth = await login("broker");
  const open = await api().get("/api/v1/units/A-1/edit").set(auth);
  const taken = await api().post("/api/v1/units/A-1/edit").set(auth).send({ version: open.body.version, fields: { ...open.body.fields, code: "B-2" } });
  expect(taken.status).toBe(409);
  expect(taken.body.error).toBe("code_used");
  expect(taken.body.code).toBe("B-2");
  expect(taken.body.message).toBeTruthy();
  const renamed = await api().post("/api/v1/units/A-1/edit").set(auth).send({ version: open.body.version, fields: { ...open.body.fields, code: "C-3" } });
  expect(renamed.status).toBe(200);
  expect(renamed.body.code).toBe("C-3");
  const rows = await h.query("SELECT code FROM listings WHERE agency_id = $1 ORDER BY code", [h.BROKERS.broker.agency_id]);
  expect(rows.map((r) => r.code)).toEqual(["B-2", "C-3"]);
});

test("'still available' on an active unit confirms it again (confirmed_at moves, status stays)", async () => {
  await ownUnit();
  await h.query(`UPDATE listings SET confirmed_at = now() - interval '30 days' WHERE code = 'A-1' AND agency_id = $1`, [h.BROKERS.broker.agency_id]);
  const auth = await login("broker");
  const r = await api().post("/api/v1/units/A-1/status").set(auth).send({ status: "active" });
  expect(r.status).toBe(200);
  const [row] = await h.query("SELECT status, confirmed_at FROM listings WHERE code = 'A-1' AND agency_id = $1", [h.BROKERS.broker.agency_id]);
  expect(row.status).toBe("active");
  expect(Date.now() - new Date(row.confirmed_at).getTime()).toBeLessThan(60000);
  const today = await api().get("/api/v1/today").set(auth);
  expect((today.body.cards?.oldUnits?.items ?? []).map((i) => i.code)).not.toContain("A-1");
});

test("picking a phase with no compound brings its parent compound (Madinaty B10 -> Madinaty)", async () => {
  await h.query(`INSERT INTO areas (id, name_key, name_en, name_ar, status, place_type) VALUES ('a0000000-0000-0000-0000-0000000000d1', 'madinaty', 'Madinaty', 'مدينتي', 'approved', 'city_or_district') ON CONFLICT DO NOTHING`);
  await h.query(`INSERT INTO areas (id, name_key, name_en, name_ar, status, place_type, parent_id) VALUES ('a0000000-0000-0000-0000-0000000000d2', 'madinaty b10', 'Madinaty B10', 'مدينتي B10', 'approved', 'phase', 'a0000000-0000-0000-0000-0000000000d1') ON CONFLICT DO NOTHING`);
  await h.query(`INSERT INTO map_places (name_key, name_en, name_ar, lat, lng, approved, area_id) VALUES ('madinaty test', 'Madinaty', 'مدينتي', 30.1, 31.6, true, 'a0000000-0000-0000-0000-0000000000d1')`);
  await h.insertListing({ code: "MIR46", compound: "Mivida", price_value: 9e6, bedrooms: 3 });
  await h.query(`UPDATE listings SET details = jsonb_build_object('owner_name', 'Owner Ali', 'owner_phone', '01012345678') WHERE code = 'MIR46' AND agency_id = $1`, [h.BROKERS.broker.agency_id]);
  const auth = await login("broker");
  const open = await api().get("/api/v1/units/MIR46/edit").set(auth);
  const r = await api().post("/api/v1/units/MIR46/edit").set(auth).send({ version: open.body.version, fields: { ...open.body.fields, compound: "", area_id: "a0000000-0000-0000-0000-0000000000d1", subzone_id: "a0000000-0000-0000-0000-0000000000d2" } });
  expect(r.status).toBe(200);
  const [row] = await h.query("SELECT compound, compound_en, subzone_id FROM listings WHERE code = 'MIR46' AND agency_id = $1", [h.BROKERS.broker.agency_id]);
  expect(row.compound).toBe("مدينتي");
  expect(row.compound_en).toBe("Madinaty");
  expect(row.subzone_id).toBe("a0000000-0000-0000-0000-0000000000d2");
});
