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
const post = async (who, path, body) => request(h.app.app).post(`/api/v1${path}`).set("Authorization", `Bearer ${await token(who)}`).send(body);

test("old units: a broker sees theirs, a manager and data entry see the agency's, private units stay hidden, status never changes", async () => {
  await h.insertListing({ code: "O-1", confirmed_at: old(30) });
  await h.insertListing({ code: "O-2", broker_id: h.BROKERS.colleague.id, confirmed_at: old(25) });
  await h.insertListing({ code: "O-NEW", confirmed_at: old(2) });
  await h.insertListing({ code: "O-P", confirmed_at: old(40), is_private: true });
  await h.query("UPDATE brokers SET role = 'data_entry' WHERE id = $1", [h.BROKERS.colleague.id]);
  const mine = (await get("broker")).body.cards.oldUnits;
  expect(mine.items.map((u) => u.code)).toEqual(["O-1"]);
  const mgr = (await get("manager")).body.cards.oldUnits;
  expect(mgr.items.map((u) => u.code).sort()).toEqual(["O-1", "O-2"]);
  const de = await get("colleague");
  expect(de.body.cards.oldUnits.total).toBe(2);
  expect(de.body.tasks).toEqual([]);
  expect((await h.query("SELECT status FROM listings WHERE code = 'O-1'"))[0].status).toBe("active");
});

test("a card with nothing in it is null", async () => {
  const c = (await get("broker")).body.cards;
  expect(c).toMatchObject({ oldUnits: null, leases: null, ops: null, approvals: null, commissions: null });
});

test("leases show three months before the end, only to the right people, and a dismissal hides one for that person", async () => {
  const unit = await h.insertListing({ code: "R-1", listing_type: "rent", confirmed_at: old(1) });
  const start = new Date(Date.now() - 300 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  await h.query("INSERT INTO leases (agency_id, listing_id, broker_id, tenant_name, start_date, months, remind) VALUES ($1, $2, $3, 'Ali', $4, 12, false)", [unit.agency_id, unit.id, h.BROKERS.broker.id, start]);
  const lease = (await get("broker")).body.cards.leases;
  expect(lease.items[0]).toMatchObject({ code: "R-1", tenant: "Ali", kind: "end" });
  expect(lease.items[0].days).toBeLessThanOrEqual(90);
  expect((await get("colleague")).body.cards.leases).toBeNull();
  expect((await get("manager")).body.cards.leases.total).toBe(1);
  expect((await post("broker", "/today/dismiss", { kind: "lease", key: lease.items[0].key })).status).toBe(200);
  expect((await get("broker")).body.cards.leases).toBeNull();
  expect((await get("manager")).body.cards.leases.total).toBe(1);
  expect((await post("broker", "/today/dismiss", { kind: "lease", key: "bad key!" })).status).toBe(422);
});
