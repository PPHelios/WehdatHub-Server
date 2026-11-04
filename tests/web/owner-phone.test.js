// tests/web/owner-phone.test.js — editing an owner's phone: logged, linked units follow, no duplicates.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const Vis = require("../../lib/visibility");
const UnitOwners = require("../../services/unitOwners");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const manager = () => ({ ...h.BROKERS.colleague, role: "manager" });

test("a manager changes the phone: the new number is kept, logged with both numbers, and units follow", async () => {
  const id = (await h.query("INSERT INTO unit_owners (agency_id, name, phones) VALUES ($1, 'Owner A', ARRAY['201066600001']) RETURNING id", [h.AGENCY_A]))[0].id;
  await h.insertListing({ code: "OP-1", broker_id: h.BROKERS.broker.id, owner_id: id });
  const r = await Vis.run(manager(), () => UnitOwners.edit(h.pool, manager(), id, { name: "Owner A", phone: "+201066600002" }));
  expect(r.ok).toBe(true);
  const [row] = await h.query("SELECT phones FROM unit_owners WHERE id = $1", [id]);
  expect(row.phones[0]).toBe("201066600002");
  const [ev] = await h.query("SELECT data FROM unit_owner_events WHERE owner_id = $1 AND kind = 'edited' ORDER BY id DESC LIMIT 1", [id]);
  expect(ev.data).toMatchObject({ phone_from: "201066600001", phone_to: "201066600002" });
  const [unit] = await h.query("SELECT owner_id FROM listings WHERE code = 'OP-1'", []);
  expect(unit.owner_id).toBe(id);
});

test("a phone already on another owner is refused, and nothing changes", async () => {
  const a = (await h.query("INSERT INTO unit_owners (agency_id, name, phones) VALUES ($1, 'Owner B', ARRAY['201077700001']) RETURNING id", [h.AGENCY_A]))[0].id;
  await h.query("INSERT INTO unit_owners (agency_id, name, phones) VALUES ($1, 'Owner C', ARRAY['201077700002'])", [h.AGENCY_A]);
  const r = await Vis.run(manager(), () => UnitOwners.edit(h.pool, manager(), a, { name: "Owner B", phone: "201077700002" }));
  expect(r.error).toBe("duplicate");
  const [row] = await h.query("SELECT phones FROM unit_owners WHERE id = $1", [a]);
  expect(row.phones[0]).toBe("201077700001");
});

test("an invalid phone is refused; an empty phone keeps the current one", async () => {
  const id = (await h.query("INSERT INTO unit_owners (agency_id, name, phones) VALUES ($1, 'Owner D', ARRAY['201088800001']) RETURNING id", [h.AGENCY_A]))[0].id;
  const bad = await Vis.run(manager(), () => UnitOwners.edit(h.pool, manager(), id, { name: "Owner D", phone: "12" }));
  expect(bad.error).toBe("bad_phone");
  const same = await Vis.run(manager(), () => UnitOwners.edit(h.pool, manager(), id, { name: "Owner D", phone: "" }));
  expect(same.ok).toBe(true);
  const [row] = await h.query("SELECT phones FROM unit_owners WHERE id = $1", [id]);
  expect(row.phones[0]).toBe("201088800001");
});
