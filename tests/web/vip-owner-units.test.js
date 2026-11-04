// tests/web/vip-owner-units.test.js — Making an owner VIP: the owner's units are ticked on a checklist (private when ticked),
// the owner's name and phone leave the units, and removing VIP puts them back. Managers never see them on a VIP owner's unit.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const UnitOwners = require("../../services/unitOwners");

jest.setTimeout(90000);

let h;
let ownerId;
beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("owner");
  await h.seedBroker("manager");
  await h.insertListing({ code: "VIP-A" });
  await h.insertListing({ code: "VIP-B" });
  await h.query("INSERT INTO unit_owners (agency_id, name, phones) VALUES ($1, 'Owner One', ARRAY['201011111111'])", [h.AGENCY_A]);
  ownerId = (await h.query("SELECT id FROM unit_owners WHERE name = 'Owner One'"))[0].id;
  await h.query("UPDATE listings SET owner_id = $1, details = jsonb_build_object('owner_name', 'Owner One', 'owner_phone', '+201011111111') WHERE code IN ('VIP-A', 'VIP-B')", [ownerId]);
});
afterAll(closeHarness);

const detailsOf = async (code) => (await h.query("SELECT details, is_private FROM listings WHERE code = $1", [code]))[0];

test("making an owner VIP ticks units private and hides the owner's details on every unit", async () => {
  const owner = await signIn(h, "owner");
  const res = await owner.agent.post(`/app/owners/${ownerId}/portfolio`).set("X-CSRF-Token", owner.csrf).type("form").send({ value: "1", units: ["VIP-A"] });
  expect(res.status).toBe(303);
  expect((await h.query("SELECT is_private FROM unit_owners WHERE id = $1", [ownerId]))[0].is_private).toBe(true);
  const a = await detailsOf("VIP-A");
  const b = await detailsOf("VIP-B");
  expect(a.is_private).toBe(true);
  expect(b.is_private).toBe(false);
  expect(a.details.owner_phone).toBeUndefined();
  expect(b.details.owner_name).toBeUndefined();
});

test("managers do not see a VIP owner or the owner's details on the unit", async () => {
  const owner = await signIn(h, "owner");
  await owner.agent.post(`/app/owners/${ownerId}/portfolio`).set("X-CSRF-Token", owner.csrf).type("form").send({ value: "1", units: [] });
  const manager = await signIn(h, "manager");
  expect((await manager.agent.get(`/app/owners/${ownerId}`)).status).toBe(404);
  const unitPage = (await manager.agent.get("/app/units/VIP-B")).text;
  expect(unitPage).not.toContain("+201011111111");
  expect(unitPage).not.toContain("Owner One");
});

test("saving a unit with a VIP owner's phone does not put the owner's details back on it", async () => {
  await h.query("UPDATE unit_owners SET is_private = true WHERE id = $1", [ownerId]);
  const broker = (await h.query("SELECT * FROM listings WHERE code = 'VIP-B'"))[0];
  const synced = await UnitOwners.syncFromListing(h.pool, { id: broker.broker_id }, { ...broker, details: { owner_name: "Owner One", owner_phone: "+201011111111" } });
  expect(synced.id).toBe(ownerId);
  expect((await detailsOf("VIP-B")).details.owner_phone).toBeUndefined();
});

test("removing VIP puts the owner's name and phone back on the units", async () => {
  const owner = await signIn(h, "owner");
  await owner.agent.post(`/app/owners/${ownerId}/portfolio`).set("X-CSRF-Token", owner.csrf).type("form").send({ value: "1", units: [] });
  expect((await detailsOf("VIP-A")).details.owner_phone).toBeUndefined();
  await owner.agent.post(`/app/owners/${ownerId}/portfolio`).set("X-CSRF-Token", owner.csrf).type("form").send({ value: "0" });
  const a = await detailsOf("VIP-A");
  expect(a.details.owner_phone).toBe("+201011111111");
  expect(a.details.owner_name).toBe("Owner One");
});
