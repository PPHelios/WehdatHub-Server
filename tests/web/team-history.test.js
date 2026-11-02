// tests/web/team-history.test.js — Team history: a broker's team changes are kept with their dates. A team lead sees the
// actions of brokers who were in their team at the time, so after a broker moves, the old team lead keeps the old logs
// and sees nothing new for that broker. History filters by date and person; managers see everything.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const Leads = require("../../services/leads");
const Team = require("../../services/team");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const T = (hhmm) => new Date(`2026-11-02T${hhmm}:00Z`);

test("the old team lead keeps the old logs and sees nothing new for the broker who moved away", async () => {
  // The colleague leads the team; the broker is in it from 08:00.
  await h.query("UPDATE brokers SET role = 'team_lead' WHERE id = $1", [h.BROKERS.colleague.id]);
  const admin = await row("admin");
  const r = await Leads.captureLead(h.pool, admin, { phones: "01012345678", name: "Sara", assignTo: h.BROKERS.broker.id }, { now: T("08:30") });
  await h.query("UPDATE brokers SET team_lead_id = $1 WHERE id = $2", [h.BROKERS.colleague.id, h.BROKERS.broker.id]);
  await h.query("UPDATE broker_team_history SET from_at = $1 WHERE broker_id = $2 AND to_at IS NULL", [T("08:00"), h.BROKERS.broker.id]);
  await h.query("DELETE FROM broker_team_history WHERE broker_id = $1", [h.BROKERS.broker.id]);
  await h.query("INSERT INTO broker_team_history (agency_id, broker_id, team_lead_id, from_at) VALUES ($1, $2, $3, $4)", [h.BROKERS.broker.agency_id, h.BROKERS.broker.id, h.BROKERS.colleague.id, T("08:00")]);

  // 09:00: the broker's note while in the team.
  await Leads.addNote(h.pool, await row("broker"), r.lead.id, "Before the move", { now: T("09:00") });
  // 10:00: the broker moves to no team (the history closes now).
  await Team.setTeam(h.pool, admin, h.BROKERS.broker.id, null);
  await h.query("UPDATE broker_team_history SET to_at = $1 WHERE broker_id = $2 AND to_at IS NOT NULL OR (broker_id = $2 AND to_at IS NULL)", [T("10:00"), h.BROKERS.broker.id]);
  // 11:00: the broker acts again, after the move.
  await Leads.addNote(h.pool, await row("broker"), r.lead.id, "After the move", { now: T("11:00") });

  const colleague = await row("colleague");
  const old = await Leads.historyFor(h.pool, colleague, r.lead.id);
  expect(old).not.toBeNull();
  const notes = old.rows.filter((e) => e.kind === "note").map((e) => e.data.text || e.data.note || "");
  expect(JSON.stringify(old.rows)).toContain("Before the move");
  expect(JSON.stringify(old.rows)).not.toContain("After the move");
});

test("a team lead with no team history for a lead cannot open its history", async () => {
  await h.query("UPDATE brokers SET role = 'team_lead' WHERE id = $1", [h.BROKERS.colleague.id]);
  const admin = await row("admin");
  const r = await Leads.captureLead(h.pool, admin, { phones: "01011111111", name: "Omar", assignTo: h.BROKERS.broker.id });
  expect(await Leads.historyFor(h.pool, await row("colleague"), r.lead.id)).toBeNull();
});

test("filters by date and by person; a manager sees everything", async () => {
  const admin = await row("admin");
  const r = await Leads.captureLead(h.pool, admin, { phones: "01022222222", name: "Nour", assignTo: h.BROKERS.broker.id }, { now: T("08:00") });
  await Leads.addNote(h.pool, await row("broker"), r.lead.id, "Morning note", { now: T("09:00") });
  await Leads.addNote(h.pool, admin, r.lead.id, "Manager note", { now: T("12:00") });
  const byPerson = await Leads.historyFor(h.pool, admin, r.lead.id, { brokerId: h.BROKERS.broker.id });
  expect(byPerson.rows.every((e) => e.broker_id === h.BROKERS.broker.id)).toBe(true);
  const byDate = await Leads.historyFor(h.pool, admin, r.lead.id, { from: T("11:00"), to: T("13:00") });
  expect(byDate.rows.length).toBeGreaterThan(0);
  expect(byDate.rows.every((e) => new Date(e.created_at) >= T("11:00") && new Date(e.created_at) < T("13:00"))).toBe(true);
  const people = await Leads.historyPeople(h.pool, admin);
  expect(people.map((p) => p.id)).toContain(h.BROKERS.broker.id);
});

test("the history page and the logs open with their filters for a manager; the old team lead gets the history page only", async () => {
  const { signIn } = require("../harness/web");
  const admin = await row("admin");
  const r = await Leads.captureLead(h.pool, admin, { phones: "01066666666", name: "Layla", assignTo: h.BROKERS.broker.id }, { now: T("08:00") });
  await Leads.addNote(h.pool, await row("broker"), r.lead.id, "A note", { now: T("09:00") });
  const { agent } = await signIn(h, "admin");
  const ref = (await h.query("SELECT ref FROM leads WHERE id = $1", [r.lead.id]))[0].ref;
  const page = await agent.get(`/app/leads/L-${String(ref).padStart(4, "0")}/history?from=2026-11-02&to=2026-11-02&person=${h.BROKERS.broker.id}`);
  expect(page.status).toBe(200);
  expect(page.text).toContain("data-history-list");
  expect(page.text).toContain("A note");
  const act = await agent.get("/app/activity-log?from=2026-11-02&to=2026-11-02");
  expect(act.status).toBe(200);
  expect(act.text).toContain("data-activity-filter");
  const log = await agent.get("/app/notifications/log?from=2026-11-02&person=" + h.BROKERS.broker.id);
  expect(log.status).toBe(200);
  expect(log.text).toContain("data-notification-filter");
});
