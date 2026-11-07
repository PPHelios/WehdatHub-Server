// tests/web/owner-requests.test.js — Owner codes, name-change requests (broker -> approver), VIP rules, suggestions.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Owners = require("../../services/unitOwners");

jest.setTimeout(60000);
let h;
beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("manager");
  await h.seedBroker("owner");
});
afterAll(closeHarness);

const A = () => h.BROKERS.broker.agency_id;
const mkOwner = async (name, phone) => Owners.findOrCreate(h.pool, A(), { phone, name, brokerId: h.BROKERS.manager.id });
const link = (o) => h.query("INSERT INTO listings (agency_id, broker_id, code, status, owner_id, listing_type, property_type, compound, details, raw_text) VALUES ($1,$2,'RQ-'||floor(random()*1e6)::int,'active',$3::uuid,'sale','apartment','X','{}'::jsonb,'x')", [A(), h.BROKERS.broker.id, o.id]);
const viewer = (who) => ({ ...h.BROKERS[who], agency_id: A() });

test("owners get short per-agency codes", async () => {
  const a = await mkOwner("Ali", "201011111111");
  const b = await mkOwner("Bob", "201022222222");
  expect(a.code).toMatch(/^O-\d{4}$/);
  expect(b.code).not.toBe(a.code);
});

test("a broker's rename becomes a request; a manager approves it", async () => {
  const o = await mkOwner("Ali", "201011111111");
  await link(o);
  const r = await Owners.edit(h.pool, viewer("broker"), o.id, { name: "Ali Hassan" });
  expect(r.error).toBeFalsy();
  expect((await h.query("SELECT name FROM unit_owners WHERE id = $1", [o.id]))[0].name).toBe("Ali");
  const [req] = await Owners.pendingFor(h.pool, viewer("manager"));
  expect(req.new_value).toBe("Ali Hassan");
  expect((await Owners.pendingFor(h.pool, viewer("broker"))).length).toBe(0);
  expect((await Owners.decideRequest(h.pool, viewer("manager"), req.id, true)).error).toBeFalsy();
  expect((await h.query("SELECT name FROM unit_owners WHERE id = $1", [o.id]))[0].name).toBe("Ali Hassan");
});

test("a broker cannot decide a request; rejecting keeps the name", async () => {
  const o = await mkOwner("Ali", "201011111111");
  await link(o);
  await Owners.edit(h.pool, viewer("broker"), o.id, { name: "Other" });
  const [req] = await Owners.pendingFor(h.pool, viewer("manager"));
  expect((await Owners.decideRequest(h.pool, viewer("broker"), req.id, true)).error).toBe("forbidden");
  await Owners.decideRequest(h.pool, viewer("owner"), req.id, false);
  expect((await h.query("SELECT name FROM unit_owners WHERE id = $1", [o.id]))[0].name).toBe("Ali");
});

test("a VIP owner's request goes to the agency owner only", async () => {
  const o = await mkOwner("Vip", "201033333333");
  await h.query("UPDATE unit_owners SET is_private = true WHERE id = $1", [o.id]);
  await Owners.requestRename(h.pool, viewer("manager"), o, "Vip Two", {});
  expect((await Owners.pendingFor(h.pool, viewer("manager"))).length).toBe(0);
  expect((await Owners.pendingFor(h.pool, viewer("owner"))).length).toBe(1);
});

test("requests page and decision route work for a manager", async () => {
  const o = await mkOwner("Ali", "201011111111");
  await link(o);
  await Owners.edit(h.pool, viewer("broker"), o.id, { name: "Ali Two" });
  const { agent, csrf } = await signIn(h, "manager");
  const page = await agent.get("/app/owners/requests");
  expect(page.status).toBe(200);
  expect(page.text).toContain("Ali Two");
  const [req] = await Owners.pendingFor(h.pool, viewer("manager"));
  const r = await agent.post(`/app/owners/requests/${req.id}`).type("form").send({ _csrf: csrf, decision: "approve" });
  expect(r.status).toBe(303);
});

test("suggest finds by name and by code; code search shows no phone", async () => {
  const o = await mkOwner("Mahmoud", "201044444444");
  const byName = await Owners.suggest(h.pool, viewer("manager"), "Mahm");
  expect(byName[0].name).toBe("Mahmoud");
  const byCode = await Owners.suggest(h.pool, viewer("manager"), o.code);
  expect(byCode[0].id).toBe(o.id);
  expect(byCode[0].phone).toBeUndefined();
});
