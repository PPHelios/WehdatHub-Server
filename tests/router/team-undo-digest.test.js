// tests/router/team-undo-digest.test.js — a team lead can undo their own reassignment (only when the assignee it restores
// is in their team, or nobody); the evening digest for a team lead counts only that team's brokers.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const Leads = require("../../services/leads");
const Digest = require("../../services/dailyDigest");

jest.setTimeout(60000);

let h;
const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const lastAssignEvent = async () => (await h.query("SELECT * FROM lead_events WHERE kind = 'assigned' ORDER BY id DESC LIMIT 1"))[0];
const assigneeOf = async (code) => (await h.query("SELECT assigned_broker_id FROM leads WHERE ref = $1", [Number(code.replace(/\D/g, ""))]))[0].assigned_broker_id;

beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("manager");
  await h.seedBroker("owner");
  await h.seedBroker("colleague");
  // Broker One is in the team of Colleague (team lead). The manager's own lead is outside that team.
  await h.query("UPDATE brokers SET role = 'team_lead' WHERE id = $1", [h.BROKERS.colleague.id]);
  await h.query("UPDATE brokers SET team_lead_id = $1 WHERE id = $2", [h.BROKERS.colleague.id, h.BROKERS.broker.id]);
  await Leads.captureLead(h.pool, await row("broker"), { phones: "01012345678", name: "Team Client" });
  await Leads.captureLead(h.pool, await row("manager"), { phones: "01012345679", name: "Manager Client" });
});
afterAll(closeHarness);

test("a team lead undoes their own reassignment inside the team", async () => {
  const teamLead = await row("colleague");
  expect((await Leads.assignLead(h.pool, teamLead, "L-0001", h.BROKERS.colleague.id)).ok).toBe(true);
  const ev = await lastAssignEvent();
  const undone = await Leads.undo(h.pool, teamLead, ev.id);
  expect(undone.ok).toBe(true);
  expect(await assigneeOf("L-0001")).toBe(h.BROKERS.broker.id);
});

test("a team lead undoes a send-back to the managers when the lead's last assignee was in their team", async () => {
  const teamLead = await row("colleague");
  expect((await Leads.assignLead(h.pool, teamLead, "L-0001", null)).ok).toBe(true);
  expect(await assigneeOf("L-0001")).toBeNull();
  const ev = await lastAssignEvent();
  expect((await Leads.undo(h.pool, teamLead, ev.id)).ok).toBe(true);
  expect(await assigneeOf("L-0001")).toBe(h.BROKERS.broker.id);
});

test("a team lead cannot undo a manager's reassignment", async () => {
  const manager = await row("manager");
  expect((await Leads.assignLead(h.pool, manager, "L-0001", h.BROKERS.colleague.id)).ok).toBe(true);
  const ev = await lastAssignEvent();
  const denied = await Leads.undo(h.pool, await row("colleague"), ev.id);
  expect(denied.error).toBe("forbidden");
  expect(await assigneeOf("L-0001")).toBe(h.BROKERS.colleague.id);
});

test("a broker cannot undo a reassignment", async () => {
  const teamLead = await row("colleague");
  expect((await Leads.assignLead(h.pool, teamLead, "L-0001", h.BROKERS.colleague.id)).ok).toBe(true);
  const ev = await lastAssignEvent();
  expect((await Leads.undo(h.pool, await row("broker"), ev.id)).error).toBe("forbidden");
});

test("the team lead's digest counts only their team's brokers; the agency digest counts everything", async () => {
  const now = new Date();
  const team = await Digest.digestData(h.pool, h.BROKERS.broker.agency_id, now, h.BROKERS.colleague.id);
  const agency = await Digest.digestData(h.pool, h.BROKERS.broker.agency_id, now);
  expect(team.team).toBe(true);
  expect(team.newLeads).toBe(1);
  expect(agency.team).toBe(false);
  expect(agency.newLeads).toBe(2);
  expect(team.brokers.map((b) => b.name)).toEqual([(await row("broker")).name]);
});
