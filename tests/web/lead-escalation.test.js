// tests/web/lead-escalation.test.js — The escalation chain for a lead nobody contacts (team's brokers, then the team
// lead, then back to the managers, all logged), team activity alerts to the team lead, and the hourly digest of
// unassigned and uncontacted leads for the managers.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const Leads = require("../../services/leads");
const LeadRules = require("../../services/leadRules");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const leadRow = async (id) => (await h.query("SELECT * FROM leads WHERE id = $1", [id]))[0];
const notesOf = (who, like) => h.query("SELECT title, kind FROM notifications WHERE broker_id = $1 AND dedupe_key LIKE $2 ORDER BY id", [h.BROKERS[who].id, like]);
const MIN = 60000;
const ALWAYS = { enabled: "on", wait_minutes: "30", start: "0", end: "24", days: ["0", "1", "2", "3", "4", "5", "6"], max_jumps: "2" };

// The colleague leads the broker's team (the broker is under them).
async function makeTeam() {
  await h.query("UPDATE brokers SET role = 'team_lead' WHERE id = $1", [h.BROKERS.colleague.id]);
  await h.query("UPDATE brokers SET team_lead_id = $1 WHERE id = $2", [h.BROKERS.colleague.id, h.BROKERS.broker.id]);
}

test("the chain: the broker, then their team lead, then back to the managers (unassigned), all logged", async () => {
  await makeTeam();
  const admin = await row("admin");
  expect((await LeadRules.saveRules(h.pool, admin, ALWAYS)).ok).toBe(true);
  const t0 = new Date("2026-11-02T10:00:00Z");
  const r = await Leads.captureLead(h.pool, admin, { phones: "01012345678", name: "Sara", assignTo: h.BROKERS.broker.id }, { now: t0 });

  // 30 minutes: no contact, so it moves to the team lead.
  expect(await LeadRules.moveOverdue(h.pool, { now: new Date(t0.getTime() + 31 * MIN) })).toEqual({ moved: 1, stopped: 0 });
  expect(await leadRow(r.lead.id)).toMatchObject({ assigned_broker_id: h.BROKERS.colleague.id });

  // Another 30 minutes: the team lead does nothing, so it goes back to the managers, unassigned.
  expect(await LeadRules.moveOverdue(h.pool, { now: new Date(t0.getTime() + 63 * MIN) })).toEqual({ moved: 0, stopped: 1 });
  expect(await leadRow(r.lead.id)).toMatchObject({ assigned_broker_id: null, response_due_at: null });
  expect((await notesOf("admin", "lead_back:%")).length).toBe(1);

  // Every step is in the lead's history.
  const events = await h.query("SELECT data FROM lead_events WHERE lead_id = $1 AND kind = 'assigned' ORDER BY id", [r.lead.id]);
  expect(events.map((e) => [e.data.from, e.data.to])).toEqual([
    [h.BROKERS.broker.id, h.BROKERS.colleague.id],
    [h.BROKERS.colleague.id, null]
  ]);
});

test("the team lead hears every broker action on their team's lead, the manager does not", async () => {
  await makeTeam();
  const admin = await row("admin");
  const r = await Leads.captureLead(h.pool, admin, { phones: "01011111111", name: "Omar", assignTo: h.BROKERS.broker.id });
  await Leads.markContacted(h.pool, await row("broker"), r.lead.id, { now: new Date() });
  const team = await notesOf("colleague", "team:%");
  expect(team.length).toBe(1);
  expect(team[0].kind).toBe("team_activity");

  // A manager's action is not sent to the team lead.
  await Leads.setStage(h.pool, admin, r.lead.id, { stage: "interested", now: new Date() });
  expect((await notesOf("colleague", "team:%")).length).toBe(1);
});

test("unassigned and uncontacted leads: one manager digest per hour, private leads never counted", async () => {
  const admin = await row("admin");
  await Leads.captureLead(h.pool, admin, { phones: "01022222222", name: "Nour" });
  const now = new Date("2026-11-02T12:00:00Z");
  const first = await LeadRules.unassignedDigest(h.pool, { now });
  expect(first.sent).toBeGreaterThan(0);
  const digest = await notesOf("admin", "unassigned_digest:%");
  expect(digest.length).toBe(1);
  expect(digest[0].title).toContain("1");
  // The same hour again does not repeat it.
  await LeadRules.unassignedDigest(h.pool, { now });
  expect((await notesOf("admin", "unassigned_digest:%")).length).toBe(1);
});
