// tests/router/team-lead.test.js — the Team Lead role: sees the leads of the brokers in their team, reassigns only inside
// the team (or sends a lead back to the managers, after which they can't see it), and hears about updates on those leads.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const Leads = require("../../services/leads");
const Team = require("../../services/team");

jest.setTimeout(60000);

let h;
const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const names = (rows) => rows.map((r) => r.name).sort();

beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("manager");
  await h.seedBroker("owner");
  await h.seedBroker("colleague");
  // Broker One is in the team of Broker Two (team lead). A second team lead has nobody under them.
  await h.query("UPDATE brokers SET role = 'team_lead' WHERE id = $1", [h.BROKERS.colleague.id]);
  await h.query("UPDATE brokers SET team_lead_id = $1 WHERE id = $2", [h.BROKERS.colleague.id, h.BROKERS.broker.id]);
  await Leads.captureLead(h.pool, await row("broker"), { phones: "01012345678", name: "Team Client" });
  await Leads.captureLead(h.pool, await row("manager"), { phones: "01012345679", name: "Manager Client" });
});
afterAll(closeHarness);

test("a team lead sees the leads of the brokers in their team, not the others", async () => {
  const teamLead = await row("colleague");
  const { rows } = await Leads.listLeads(h.pool, teamLead);
  expect(rows.map((l) => l.name)).toEqual(["Team Client"]);
  expect(await Leads.getLead(h.pool, teamLead, "L-0001")).toBeTruthy();
  expect(await Leads.getLead(h.pool, teamLead, "L-0002")).toBeNull();
});

test("a team lead reassigns within the team, and cannot hand a lead to someone outside it", async () => {
  const teamLead = await row("colleague");
  await h.query("INSERT INTO brokers (id, agency_id, phone_number, name, role, is_active, preferred_lang, team_lead_id) SELECT '30000000-0000-0000-0000-000000000001', agency_id, '201000000031', 'Outsider', 'broker', true, 'ar', NULL FROM brokers WHERE id = $1", [h.BROKERS.broker.id]);
  const outsider = (await h.query("SELECT * FROM brokers WHERE name = 'Outsider'"))[0];
  const denied = await Leads.assignLead(h.pool, teamLead, "L-0001", outsider.id);
  expect(denied.error).toBe("forbidden");

  const ok = await Leads.assignLead(h.pool, teamLead, "L-0001", h.BROKERS.colleague.id);
  expect(ok.ok).toBe(true);
});

test("a team lead sends a lead back to the managers; then they can't see it", async () => {
  const teamLead = await row("colleague");
  const back = await Leads.assignLead(h.pool, teamLead, "L-0001", null);
  expect(back.ok).toBe(true);
  expect(await Leads.getLead(h.pool, teamLead, "L-0001")).toBeNull();
  expect((await Leads.listLeads(h.pool, teamLead)).rows).toEqual([]);
});

test("a broker cannot reassign leads", async () => {
  const r = await Leads.assignLead(h.pool, await row("broker"), "L-0001", h.BROKERS.colleague.id);
  expect(r.error).toBe("forbidden");
});

test("the team lead hears about an update on a lead in their team, but not about their own", async () => {
  await Leads.addNote(h.pool, await row("broker"), "L-0001", "Client wants a second viewing");
  const told = await h.query("SELECT broker_id, title FROM notifications WHERE kind = 'manager_alert' AND broker_id = $1", [h.BROKERS.colleague.id]);
  expect(told.length).toBe(1);
  await Leads.addNote(h.pool, await row("colleague"), "L-0001", "My own note");
  const again = await h.query("SELECT 1 FROM notifications WHERE broker_id = $1", [h.BROKERS.colleague.id]);
  expect(again.length).toBe(1);
});

test("managers set the team and the team lead role; taking the role back clears the team", async () => {
  const manager = await row("manager");
  expect((await Team.setTeam(h.pool, manager, h.BROKERS.broker.id, manager.id)).error).toBe("team_lead_not_found");
  expect((await Team.setTeam(h.pool, manager, h.BROKERS.broker.id, h.BROKERS.colleague.id)).ok).toBe(true);
  expect((await Team.setTeamLeadRole(h.pool, manager, h.BROKERS.colleague.id, false)).ok).toBe(true);
  const [b1] = await h.query("SELECT team_lead_id FROM brokers WHERE id = $1", [h.BROKERS.broker.id]);
  expect(b1.team_lead_id).toBeNull();
});
