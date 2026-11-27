// tests/api/today.test.js — The app's Today: the signed-in broker's own follow-ups, viewings, hot and new leads.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");
const Leads = require("../../services/leads");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(() => closeHarness());

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
async function token(who) {
  const b = h.BROKERS[who];
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  return (await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: b.phone, code })).body.token;
}
const get = async (who) => request(h.app.app).get("/api/v1/today").set("Authorization", `Bearer ${await token(who)}`);

test("Today needs a sign-in", async () => {
  expect((await request(h.app.app).get("/api/v1/today")).status).toBe(401);
});

test("Today lists the broker's own late, viewing and call tasks and counts new leads; colleagues' leads never appear", async () => {
  await Leads.captureLead(h.pool, await row("broker"), { phones: "01012345678", name: "Sara Late" });
  await Leads.captureLead(h.pool, await row("broker"), { phones: "01112345678", name: "Omar Viewing" });
  await Leads.captureLead(h.pool, await row("broker"), { phones: "01212345678", name: "Mona New" });
  await Leads.captureLead(h.pool, await row("colleague"), { phones: "01512345678", name: "Not Mine" });
  const hour = 3600 * 1000;
  const set = (name, ms, kind) =>
    h.query("UPDATE leads SET follow_up_status = 'open', next_follow_up_at = $2, follow_up_kind = $3 WHERE name = $1", [name, new Date(Date.now() + ms).toISOString(), kind]);
  await set("Sara Late", -3 * 24 * hour, "call");
  await set("Omar Viewing", hour / 60, "viewing"); // one minute ahead, so it stays "today" in Cairo time even late in the evening
  await set("Not Mine", -3 * 24 * hour, "call");
  const res = await get("broker");
  expect(res.status).toBe(200);
  const byName = Object.fromEntries(res.body.tasks.map((t) => [t.name, t]));
  expect(byName["Sara Late"]).toMatchObject({ kind: "late", phone: "201012345678" });
  expect(byName["Sara Late"].ref).toMatch(/^L-\d{4}$/);
  expect(byName["Omar Viewing"].kind).toBe("viewing");
  expect(byName["Not Mine"]).toBeUndefined();
  expect(res.body.counts.newLeads).toBeGreaterThanOrEqual(1);
  expect(res.body.moreTasks).toBe(0);
});

test("a broker with nothing waiting gets an empty list, not an error", async () => {
  const res = await get("colleague");
  expect(res.status).toBe(200);
  expect(res.body.tasks).toEqual([]);
});

const old = (days) => new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

test("old units: only data entry sees them on today, private units stay hidden, status never changes", async () => {
  await h.insertListing({ code: "O-1", confirmed_at: old(30) });
  await h.insertListing({ code: "O-2", broker_id: h.BROKERS.colleague.id, confirmed_at: old(25) });
  await h.insertListing({ code: "O-NEW", confirmed_at: old(2) });
  await h.insertListing({ code: "O-P", confirmed_at: old(40), is_private: true });
  await h.query("UPDATE brokers SET role = 'data_entry' WHERE id = $1", [h.BROKERS.colleague.id]);
  await h.seedBroker("manager");
  expect((await get("broker")).body.cards.oldUnits).toBeNull();
  expect((await get("manager")).body.cards.oldUnits).toBeNull();
  const de = await get("colleague");
  expect(de.body.cards.oldUnits.total).toBe(2);
  expect(de.body.tasks).toEqual([]);
  expect((await h.query("SELECT status FROM listings WHERE code = 'O-1'"))[0].status).toBe("active");
});

test("owner and manager can toggle dataEntryMissingPhotos and dataEntryOverdueUnits switches", async () => {
  await h.insertListing({ code: "O-1", confirmed_at: old(30) });
  await h.query("UPDATE brokers SET role = 'data_entry' WHERE id = $1", [h.BROKERS.colleague.id]);
  await h.seedBroker("manager");
  const mgrAuth = { Authorization: `Bearer ${await token("manager")}` };
  const deAuth = { Authorization: `Bearer ${await token("colleague")}` };

  const settingsRes = await request(h.app.app).get("/api/v1/settings").set(mgrAuth);
  expect(settingsRes.status).toBe(200);
  expect(settingsRes.body.switches).toEqual({ dataEntryMissingPhotos: true, dataEntryOverdueUnits: true });

  const saveRes = await request(h.app.app).post("/api/v1/settings").set(mgrAuth)
    .send({ switches: { dataEntryMissingPhotos: false, dataEntryOverdueUnits: false } });
  expect(saveRes.status).toBe(200);

  const homeDe = await request(h.app.app).get("/api/v1/today/home").set(deAuth);
  expect(homeDe.status).toBe(200);
  expect(homeDe.body.missingPhotos).toBe(0);
  expect(homeDe.body.units.total).toBe(0);
  expect(homeDe.body.priorities).toEqual([]);
});

test("a card with nothing in it is null", async () => {
  const c = (await get("broker")).body.cards;
  expect(c).toMatchObject({ oldUnits: null, ops: null, approvals: null, commissions: null });
});

test("the units list can show just the old units the card points to", async () => {
  await h.insertListing({ code: "O-1", confirmed_at: old(30) });
  await h.insertListing({ code: "O-NEW", confirmed_at: old(2) });
  const res = await request(h.app.app).get("/api/v1/units?status=active&old=1").set("Authorization", `Bearer ${await token("broker")}`);
  expect(res.status).toBe(200);
  expect(res.body.items.map((u) => u.code)).toEqual(["O-1"]);
});

test("data entry home previews the oldest three, counts the full visible queue and refreshes after confirmation", async () => {
  await h.query("UPDATE brokers SET role = 'data_entry' WHERE id = $1", [h.BROKERS.colleague.id]);
  for (const [code, days] of [["NEW", 1], ["O-1", 25], ["O-2", 50], ["O-3", 30], ["O-4", 35]]) {
    await h.insertListing({ code, confirmed_at: old(days) });
  }
  await h.insertListing({ code: "PRIVATE", confirmed_at: old(65), is_private: true });
  const auth = { Authorization: `Bearer ${await token("colleague")}` };
  const load = (suffix) => request(h.app.app).get(`/api/v1/today/${suffix}`).set(auth);
  const brief = await load("home");
  expect(brief.status).toBe(200);
  expect(brief.body.units.total).toBe(4);
  expect(brief.body.units.items.map((u) => u.code)).toEqual(["O-2", "O-4", "O-3"]);
  const queue = await load("overdue-units?offset=1");
  expect(queue.status).toBe(200);
  expect(queue.body.items.map((u) => u.code)).toEqual(["O-4", "O-3", "O-1"]);
  await h.query("UPDATE listings SET confirmed_at = now() WHERE agency_id = $1 AND code = 'O-2'", [h.AGENCY_A]);
  const updated = await load("home");
  expect(updated.body.units.total).toBe(3);
  expect(updated.body.units.items.map((u) => u.code)).toEqual(["O-4", "O-3", "O-1"]);
});

test("the evening brief shows recorded agency deals, and personal counts for a broker", async () => {
  const Today = require("../../services/today");
  const evening = new Date("2026-11-23T18:30:00Z");
  const broker = await Today.home(h.pool, await row("broker"), evening);
  expect(broker).toMatchObject({ hour: 20, completed: 0, tomorrowViewings: 0, ops: null });
  const manager = await Today.home(h.pool, await row("admin"), evening);
  expect(manager).toMatchObject({ hour: 20, completed: 0, tomorrowViewings: 0 });
});

test("home priorities rank Waiting > 1h, intake alerts, and missing photos without duplicating old fields", async () => {
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const broker = await row("broker");
  const admin = await row("admin");
  const lead = await Leads.captureLead(h.pool, broker, { phones: "01055551111", name: "Waiting 2h" });
  await h.query("UPDATE leads SET created_at = $2 WHERE id = $1", [lead.lead.id, twoHoursAgo]);
  await h.insertListing({ code: "NO-PIC-1", broker_id: broker.id });
  await h.query(
    "INSERT INTO lead_intakes (agency_id, source, name, token_hash, token_hint, status) VALUES ($1, 'facebook', 'FB Page 1', 'hash1', 'hint1', 'disconnected')",
    [h.AGENCY_A]
  );

  const authMgr = { Authorization: `Bearer ${await token("admin")}` };
  const mgrRes = await request(h.app.app).get("/api/v1/today/home").set(authMgr);
  expect(mgrRes.status).toBe(200);
  expect(mgrRes.body).toMatchObject({ waitingOver1h: 1, missingPhotos: 1, intake: { disconnected: 1, failed: 0 } });
  expect(mgrRes.body.priorities.map((p) => p.id)).toEqual(["waiting-over-1h", "intake"]);
  const [mgrWaiting, mgrIntake] = mgrRes.body.priorities;
  expect(mgrWaiting).toMatchObject({ canNudge: true, canAssign: true, lead: { ref: lead.lead.ref ? expect.any(String) : expect.any(String), version: expect.any(Number), assigneeId: broker.id, lastAutoReminderAt: null } });
  expect(JSON.stringify(mgrWaiting.lead)).not.toContain("0105555");
  expect(mgrIntake).not.toHaveProperty("lead");

  const authBroker = { Authorization: `Bearer ${await token("broker")}` };
  const brokerRes = await request(h.app.app).get("/api/v1/today/home").set(authBroker);
  expect(brokerRes.status).toBe(200);
  expect(brokerRes.body.priorities.map((p) => p.id)).toEqual(["waiting-over-1h"]);
  expect(brokerRes.body.priorities[0]).toMatchObject({ canNudge: false, canAssign: false });
  // Uncontacted leads under 1h are distinct from waiting-over-1h; with 0 fresh remaining, new-leads is omitted.
  expect(brokerRes.body.newLeads).toBe(1);
  expect(admin.role).toBe("admin");
});

test("team_lead new-leads priority keeps scoped uncontacted leads under 1h and excludes intake alerts when sources are gated", async () => {
  await h.query("UPDATE brokers SET role = 'team_lead' WHERE id = $1", [h.BROKERS.colleague.id]);
  const broker = await row("broker");
  const tl = await row("colleague");
  await h.query("UPDATE brokers SET team_lead_id = $2 WHERE id = $1", [broker.id, tl.id]);
  await h.query(
    "INSERT INTO lead_intakes (agency_id, source, name, token_hash, token_hint, status) VALUES ($1, 'facebook', 'FB Gated', 'hash2', 'hint2', 'disconnected')",
    [h.AGENCY_A]
  );

  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const teamWait = await Leads.captureLead(h.pool, broker, { phones: "01066661111", name: "Team Wait 2h" });
  await h.query("UPDATE leads SET created_at = $2 WHERE id = $1", [teamWait.lead.id, twoHoursAgo]);
  await Leads.captureLead(h.pool, tl, { phones: "01066662222", name: "TL Fresh" });

  const tlRes = await request(h.app.app).get("/api/v1/today/home").set({ Authorization: `Bearer ${await token("colleague")}` });
  expect(tlRes.status).toBe(200);
  expect(tlRes.body.priorities.map((p) => [p.id, p.count])).toEqual([
    ["waiting-over-1h", 1],
    ["new-leads", 1]
  ]);

  const Today = require("../../services/today");
  const teamTierViewer = { ...(await row("admin")), workspace: { tier: "team", mode: "team", members: 3, keep: [] } };
  const gatedHome = await Today.home(h.pool, teamTierViewer);
  expect(gatedHome.intake).toEqual({ disconnected: 0, failed: 0 });
  expect(gatedHome.priorities.map((p) => p.id)).not.toContain("intake");
});

test("home adds stale units and stuck leads with why and a decisions summary", async () => {
  const broker = await row("broker");
  const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
  await h.insertListing({ code: "STALE-1", broker_id: broker.id });
  await h.query("UPDATE listings SET confirmed_at = $2, updated_at = $2 WHERE agency_id = $1 AND code = 'STALE-1'", [h.AGENCY_A, old]);
  const { lead } = await Leads.captureLead(h.pool, broker, { phones: "01077771111", name: "Stuck" });
  await h.query("UPDATE leads SET stage = 'contacted', last_activity_at = $2 WHERE id = $1", [lead.id, old]);
  const res = await request(h.app.app).get("/api/v1/today/home").set({ Authorization: `Bearer ${await token("broker")}` });
  const ids = res.body.priorities.map((p) => p.id);
  expect(ids).toEqual(expect.arrayContaining(["stuck-leads", "stale-units"]));
  expect(res.body.priorities.every((p) => p.why)).toBe(true);
  expect(res.body.summary.decisions).toBeGreaterThanOrEqual(1);
});
