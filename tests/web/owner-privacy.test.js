// tests/web/owner-privacy.test.js — The agency owner's private owner profiles: only the agency owner sees or sets them;
// managers and brokers get a 404 and no row in the list; the change is logged; jobs never see them.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Vis = require("../../lib/visibility");

jest.setTimeout(90000);

let h;
let publicId;
let secretId;
beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("owner");
  await h.seedBroker("manager");
  await h.insertListing({ code: "PUB-1" });
  await h.query("INSERT INTO unit_owners (agency_id, name, phones, is_private) VALUES ($1, 'Public Owner', ARRAY['201011111111'], false)", [h.AGENCY_A]);
  await h.query("INSERT INTO unit_owners (agency_id, name, phones, is_private) VALUES ($1, 'Secret Owner', ARRAY['201022222222'], true)", [h.AGENCY_A]);
  publicId = (await h.query("SELECT id FROM unit_owners WHERE name = 'Public Owner'"))[0].id;
  secretId = (await h.query("SELECT id FROM unit_owners WHERE name = 'Secret Owner'"))[0].id;
  await h.query("UPDATE listings SET owner_id = $1 WHERE code = 'PUB-1'", [publicId]);
});
afterAll(closeHarness);

test("managers and brokers never see a private owner; the agency owner does", async () => {
  for (const who of ["manager", "broker"]) {
    const s = await signIn(h, who);
    const list = (await s.agent.get("/app/owners")).text;
    expect(list).not.toContain("Secret Owner");
    expect((await s.agent.get(`/app/owners/${secretId}`)).status).toBe(404);
    expect((await s.agent.get("/app/owners?private=1")).text).not.toContain("Secret Owner");
  }
  const owner = await signIn(h, "owner");
  expect((await owner.agent.get("/app/owners")).text).toContain("Secret Owner");
  expect((await owner.agent.get(`/app/owners/${secretId}`)).status).toBe(200);
  const onlyPrivate = (await owner.agent.get("/app/owners?private=1")).text;
  expect(onlyPrivate).toContain("Secret Owner");
  expect(onlyPrivate).not.toContain("Public Owner");
});

test("only the agency owner marks a profile private, and the change is logged", async () => {
  const post = (s, path, value) => s.agent.post(path).set("X-CSRF-Token", s.csrf).type("form").send({ value });
  const manager = await signIn(h, "manager");
  expect((await post(manager, `/app/owners/${publicId}/portfolio`, "1")).status).toBe(404);
  const owner = await signIn(h, "owner");
  expect((await post(owner, `/app/owners/${publicId}/portfolio`, "1")).status).toBe(303);
  expect((await h.query("SELECT is_private FROM unit_owners WHERE id = $1", [publicId]))[0].is_private).toBe(true);
  expect((await (await signIn(h, "manager")).agent.get(`/app/owners/${publicId}`)).status).toBe(404);
  expect((await post(owner, `/app/owners/${publicId}/portfolio`, "0")).status).toBe(303);
  expect((await (await signIn(h, "manager")).agent.get(`/app/owners/${publicId}`)).status).toBe(200);
  expect((await h.query("SELECT 1 FROM operation_logs WHERE operation_type = 'portfolio_private' AND metadata->>'kind' = 'owner'")).length).toBe(2);
});

test("a job (no viewer) never sees a private owner profile", async () => {
  const jobSees = await Vis.run(null, async () => (await h.pool.query(`SELECT name FROM unit_owners o WHERE ${Vis.owners("o")} ORDER BY name`)).rows.map((r) => r.name));
  expect(jobSees).toEqual(["Public Owner"]);
});

test("a broker sees and edits an owner through their own unit; without one, or an approval, the owner is hidden", async () => {
  const post = (s, path, body) => s.agent.post(path).set("X-CSRF-Token", s.csrf).type("form").send(body);
  const broker = await signIn(h, "broker");
  expect((await broker.agent.get(`/app/owners/${publicId}`)).status).toBe(200);
  expect((await post(broker, `/app/owners/${publicId}`, { name: "Renamed by broker", notes: "called", flag: "" })).status).toBe(303);
  expect((await h.query("SELECT name FROM unit_owners WHERE id = $1", [publicId]))[0].name).toBe("Public Owner"); // a broker's rename is a request now
  expect((await h.query("SELECT new_value FROM owner_change_requests WHERE owner_id = $1 AND status = 'pending'", [publicId]))[0].new_value).toBe("Renamed by broker");

  // An owner whose only unit belongs to another broker: hidden and not editable until a manager approves a request.
  await h.insertListing({ code: "OTHER-1", broker_id: h.BROKERS.owner.id });
  await h.query("INSERT INTO unit_owners (agency_id, name, phones, is_private) VALUES ($1, 'Other Owner', ARRAY['201033333333'], false)", [h.AGENCY_A]);
  const otherId = (await h.query("SELECT id FROM unit_owners WHERE name = 'Other Owner'"))[0].id;
  await h.query("UPDATE listings SET owner_id = $1 WHERE code = 'OTHER-1'", [otherId]);
  expect((await broker.agent.get(`/app/owners/${otherId}`)).status).toBe(404);
  expect((await post(broker, `/app/owners/${otherId}`, { name: "Nope", notes: "", flag: "" })).status).toBe(403);
  const listing = (await h.query("SELECT id FROM listings WHERE code = 'OTHER-1'"))[0];
  await h.query(
    "INSERT INTO unit_access_requests (agency_id, listing_id, broker_id, status, decided_at) VALUES ($1, $2, $3, 'approved', now())",
    [h.AGENCY_A, listing.id, h.BROKERS.broker.id]
  );
  expect((await broker.agent.get(`/app/owners/${otherId}`)).status).toBe(200);
  expect((await post(broker, `/app/owners/${otherId}`, { name: "Still no", notes: "", flag: "" })).status).toBe(403);
});
