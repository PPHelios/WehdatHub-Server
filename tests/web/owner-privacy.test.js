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
