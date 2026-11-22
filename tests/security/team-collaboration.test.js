"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const WebAuth = require("../../lib/webAuth");
const PlanGuard = require("../../lib/planGuard");
const Workspace = require("../../lib/workspace");
const Leads = require("../../services/leads");

let h;
jest.setTimeout(90000);
beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("owner");
  await h.seedBroker("manager");
  await plan("team");
});
afterAll(closeHarness);

async function plan(id) {
  await h.query("UPDATE agencies SET pilot = false, plan = $2, paid_until = now() + interval '30 days' WHERE id = $1", [h.AGENCY_A, id]);
  PlanGuard.forget(h.AGENCY_A);
  Workspace.forget(h.AGENCY_A);
}

async function mobile(who) {
  const broker = h.BROKERS[who];
  const code = await WebAuth.issueLoginCode(h.pool, { id: broker.id, agency_id: broker.agency_id });
  const response = await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: broker.phone, code });
  expect(response.status).toBe(200);
  return (method, path) => request(h.app.app)[method](`/api/v1${path}`).set("Authorization", `Bearer ${response.body.token}`);
}

const post = (web, path, data) => web.agent.post(`/app${path}`).type("form").send({ _csrf: web.csrf, ...data });
const unit = async () => (await h.query("SELECT * FROM listings WHERE agency_id = $1 AND code = 'TEAM-1'", [h.AGENCY_A]))[0];
const actor = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];

test("a Team owner can switch on colleague edits across both surfaces without granting sensitive access or deletion", async () => {
  await h.insertListing({ code: "TEAM-1", price_value: 9000000, compound: "Mivida" });
  await h.query("UPDATE listings SET details = jsonb_build_object('owner_phone', '01012345678') WHERE id = $1", [(await unit()).id]);
  const peer = await mobile("colleague");
  const webPeer = await signIn(h, "colleague");
  const webOwner = await signIn(h, "owner");
  const owner = await mobile("owner");
  const path = "/units/TEAM-1";
  const version = (await unit()).version;
  expect((await peer("get", path)).body.canEditColleague).toBeFalsy();
  expect((await peer("patch", `${path}/colleague`).send({ version, price: 8500000 })).status).toBe(403);
  expect((await peer("post", "/settings").send({ switches: { brokersEditColleagueUnits: true } })).status).toBe(403);
  expect((await post(webOwner, "/team/collaboration", { brokersEditColleagueUnits: "1" })).status).toBe(303);
  expect((await owner("get", "/settings")).body.switches.brokersEditColleagueUnits).toBe(true);
  expect((await peer("get", path)).body.canEditColleague).toBe(true);
  expect((await peer("get", `${path}/edit`)).status).toBe(403);
  expect((await peer("get", `${path}/contact`)).status).toBe(403);

  const changed = await peer("patch", `${path}/colleague`).send({ version, price: 8500000 });
  expect(changed.status).toBe(200);
  expect(changed.text).not.toContain("01012345678");
  expect(Number((await unit()).price_value)).toBe(8500000);
  expect((await peer("patch", `${path}/colleague`).send({ version, price: 8400000 })).status).toBe(409);
  expect((await post(webPeer, `${path}/colleague`, { version: (await unit()).version, price: 8300000 })).status).toBe(303);
  expect(Number((await unit()).price_value)).toBe(8300000);
  expect((await unit()).broker_id).toBe(h.BROKERS.broker.id);
  expect((await peer("post", `${path}/delete`)).status).toBe(403);

  expect((await owner("post", "/settings").send({ switches: { brokersMayWrite: false } })).status).toBe(200);
  expect((await peer("patch", `${path}/colleague`).send({ version: (await unit()).version, price: 8400000 })).status).toBe(403);
  expect((await post(webOwner, `${path}/portfolio`, { value: "1" })).status).toBe(303);
  expect((await peer("get", path)).status).toBe(404);
});

test("a Shared Team lead can only be claimed once across web and mobile", async () => {
  const webOwner = await signIn(h, "owner");
  const webBroker = await signIn(h, "broker");
  const peer = await mobile("colleague");
  expect((await post(webOwner, "/team/style", { style: "shared" })).status).toBe(200);
  expect((await post(webOwner, "/team/collaboration", { brokersSeeAllLeads: "1", brokersWorkSharedLeads: "1" })).status).toBe(303);
  await Leads.captureLead(h.pool, await actor("owner"), { phones: "01012345678", name: "Shared enquiry", kind: "buyer" });
  const [lead] = await h.query("SELECT * FROM leads WHERE agency_id = $1", [h.AGENCY_A]);
  const path = `/leads/L-${String(lead.ref).padStart(4, "0")}`;
  const [webResult, mobileResult] = await Promise.all([
    post(webBroker, `${path}/claim`, { version: lead.version }),
    peer("post", `${path}/claim`).send({ version: lead.version })
  ]);
  const [saved] = await h.query("SELECT assigned_broker_id, version FROM leads WHERE id = $1", [lead.id]);
  expect([h.BROKERS.broker.id, h.BROKERS.colleague.id]).toContain(saved.assigned_broker_id);
  expect(saved.version).toBe(lead.version + 1);
  const webWon = saved.assigned_broker_id === h.BROKERS.broker.id;
  expect(webResult.status).toBe(webWon ? 303 : 409);
  expect(mobileResult.status).toBe(webWon ? 409 : 200);
});

test("a lone Solo owner has newly captured clients assigned to themselves", async () => {
  await h.query("UPDATE brokers SET is_active = false WHERE agency_id = $1 AND id <> $2", [h.AGENCY_A, h.BROKERS.owner.id]);
  await plan("solo");
  const owner = await mobile("owner");
  const created = await owner("post", "/leads").send({ phone1: "01012345678", name: "Solo enquiry", kind: "buyer" });
  expect(created.status).toBe(201);
  const [saved] = await h.query("SELECT assigned_broker_id FROM leads WHERE agency_id = $1", [h.AGENCY_A]);
  expect(saved.assigned_broker_id).toBe(h.BROKERS.owner.id);
});

test("Office retains its existing distinction between editing a colleague’s unit and deleting one's own unit", async () => {
  await plan("office");
  await h.insertListing({ code: "TEAM-1", price_value: 9000000 });
  const peer = await mobile("colleague");
  expect((await peer("get", "/units/TEAM-1")).body.canEditColleague).toBeFalsy();
  const broker = await mobile("broker");
  expect((await broker("post", "/units/TEAM-1/delete")).status).toBe(200);
  expect((await unit()).status).toBe("deleted");
});
