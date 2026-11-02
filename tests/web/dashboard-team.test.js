// tests/web/dashboard-team.test.js — the agency dashboard can be narrowed to one team lead's team: only that team's
// leads, deals and brokers count. A bad or non-team-lead id gives the whole agency view.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const Leads = require("../../services/leads");
const Dash = require("../../services/dashboards");

jest.setTimeout(60000);

let h;
const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];

beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("manager");
  await h.seedBroker("colleague");
  // Broker One is in the team of Colleague (team lead).
  await h.query("UPDATE brokers SET role = 'team_lead' WHERE id = $1", [h.BROKERS.colleague.id]);
  await h.query("UPDATE brokers SET team_lead_id = $1 WHERE id = $2", [h.BROKERS.colleague.id, h.BROKERS.broker.id]);
  await Leads.captureLead(h.pool, await row("broker"), { phones: "01012345678", name: "Team Client" });
  await Leads.captureLead(h.pool, await row("colleague"), { phones: "01012345679", name: "Lead Lead" });
  await Leads.captureLead(h.pool, await row("manager"), { phones: "01012345680", name: "Agency Client" });
});
afterAll(closeHarness);

test("the team view counts only the team's leads; the agency view counts all of them", async () => {
  const manager = await row("manager");
  const agency = await Dash.agencyDashboard(h.pool, manager, { days: 30 });
  const team = await Dash.agencyDashboard(h.pool, manager, { days: 30, teamLeadId: h.BROKERS.colleague.id });
  expect(agency.teamLeadId).toBeNull();
  expect(team.teamLeadId).toBe(h.BROKERS.colleague.id);
  expect(team.leads).toBe(1);
  expect(agency.leads).toBeGreaterThan(team.leads);
  expect(team.board.map((b) => b.id)).toEqual([h.BROKERS.broker.id]);
  expect(team.teamLeads.map((t) => t.id)).toContain(h.BROKERS.colleague.id);
});

test("an id that is not a team lead, or a malformed one, gives the agency view", async () => {
  const manager = await row("manager");
  const agency = await Dash.agencyDashboard(h.pool, manager, { days: 30 });
  const notLead = await Dash.agencyDashboard(h.pool, manager, { days: 30, teamLeadId: h.BROKERS.broker.id });
  const malformed = await Dash.agencyDashboard(h.pool, manager, { days: 30, teamLeadId: "not-a-uuid" });
  expect(notLead.leads).toBe(agency.leads);
  expect(malformed.leads).toBe(agency.leads);
  expect(notLead.teamLeadId).toBeNull();
});

test("brokers and non-managers are still refused", async () => {
  expect(await Dash.agencyDashboard(h.pool, await row("broker"), { days: 30, teamLeadId: h.BROKERS.colleague.id })).toBeNull();
});
