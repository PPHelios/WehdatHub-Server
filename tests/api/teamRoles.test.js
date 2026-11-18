// tests/api/teamRoles.test.js — The app's team roles match the website: the owner moves people between broker, manager
// and data entry; a manager makes a broker a team lead (or takes it back) and puts brokers in a team. Same services
// (services/team.js), so the same refusals.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("manager");
  await h.seedBroker("owner");
});
afterAll(() => closeHarness());

const api = () => request(h.app.app);
async function as(who) {
  const b = h.BROKERS[who];
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const t = (await api().post("/api/v1/auth/code/verify").send({ phone: b.phone, code })).body.token;
  return { Authorization: `Bearer ${t}` };
}
const roleOf = async (id) => (await h.pool.query("SELECT role, team_lead_id FROM brokers WHERE id = $1", [id])).rows[0];
const B = () => h.BROKERS;

test("the owner moves a broker to data entry and back", async () => {
  const owner = await as("owner");
  expect((await api().post(`/api/v1/team/${B().colleague.id}/role`).set(owner).send({ role: "data_entry" })).status).toBe(200);
  expect((await roleOf(B().colleague.id)).role).toBe("data_entry");
  expect((await api().post(`/api/v1/team/${B().colleague.id}/role`).set(owner).send({ role: "broker" })).status).toBe(200);
  expect((await roleOf(B().colleague.id)).role).toBe("broker");
});

test("a manager makes a broker a team lead, puts another broker in the team, then takes the role back", async () => {
  const manager = await as("manager");
  const on = await api().post(`/api/v1/team/${B().colleague.id}/team-role`).set(manager).send({ on: true });
  expect(on.status).toBe(200);
  expect(on.body).toMatchObject({ ok: true, to: "team_lead" });
  expect((await api().post(`/api/v1/team/${B().colleague.id}/team-role`).set(manager).send({ on: true })).status).toBe(409);

  expect((await api().post(`/api/v1/team/${B().broker.id}/team`).set(manager).send({ teamLeadId: B().colleague.id })).status).toBe(200);
  expect((await roleOf(B().broker.id)).team_lead_id).toBe(B().colleague.id);
  const board = (await api().get("/api/v1/team").set(manager)).body.items;
  expect(board.find((m) => m.id === B().broker.id).teamLeadId).toBe(B().colleague.id);

  expect((await api().post(`/api/v1/team/${B().colleague.id}/team-role`).set(manager).send({ on: false })).status).toBe(200);
  expect((await roleOf(B().colleague.id)).role).toBe("broker");
  expect((await roleOf(B().broker.id)).team_lead_id).toBe(null);
});

test("brokers cannot change team roles or teams; nobody reaches another agency's people", async () => {
  const broker = await as("broker");
  expect((await api().post(`/api/v1/team/${B().colleague.id}/team-role`).set(broker).send({ on: true })).status).toBe(403);
  expect((await api().post(`/api/v1/team/${B().colleague.id}/team`).set(broker).send({ teamLeadId: null })).status).toBe(403);
  const manager = await as("manager");
  expect((await api().post(`/api/v1/team/${B().rival.id}/team-role`).set(manager).send({ on: true })).status).toBe(404);
  expect((await api().post(`/api/v1/team/${B().rival.id}/team`).set(manager).send({ teamLeadId: null })).status).toBe(404);
  expect((await api().post(`/api/v1/team/${B().broker.id}/team`).set(manager).send({ teamLeadId: B().colleague.id })).status).toBe(404);
  expect((await roleOf(B().rival.id)).role).toBe("broker");
});
