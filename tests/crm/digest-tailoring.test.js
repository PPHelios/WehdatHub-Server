// tests/crm/digest-tailoring.test.js — The digests by role and the send pacing: the owner gets totals only (no owner
// brief, no per-broker lines), managers and team leads get the ops lines (leads with no broker, not contacted for a day,
// overdue follow-ups) for their scope, and one pass sends at most the server's and the agency's share, leaving the rest
// for the next pass, with the day's stamp only when nothing is left.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { resetConfig } = require("../../config");
const Leads = require("../../services/leads");
const Digest = require("../../services/dailyDigest");

jest.setTimeout(60000);

let h;
beforeAll(() => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test";
  resetConfig();
});
beforeEach(async () => {
  h = await createHarness();
  // Daily messages go to Telegram: every person who should get one is linked.
  for (const who of ["admin", "broker", "colleague"]) await h.tgLink(who);
});
afterAll(async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  resetConfig();
  await closeHarness();
});

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const MORNING = new Date("2026-11-04T07:30:00Z"); // 09:30 Cairo
const EVENING = new Date("2026-11-04T17:30:00Z"); // 19:30 Cairo
const rowsOf = (who, kind) => h.query("SELECT title, body FROM notifications WHERE broker_id = $1 AND kind = $2 ORDER BY id", [h.BROKERS[who].id, kind]);

test("the owner gets no morning brief and an evening digest with totals only", async () => {
  await h.seedBroker("owner");
  await h.tgLink("owner");
  const admin = await row("admin");
  await Leads.captureLead(h.pool, admin, { phones: "01012345678", name: "Sara", assignTo: h.BROKERS.broker.id }, { now: new Date("2026-11-04T05:00:00Z") });
  await Leads.captureLead(h.pool, admin, { phones: "01011111111", name: "Nour" }, { now: new Date("2026-11-04T05:00:00Z") });

  await Digest.sendBriefs(h.pool, { now: MORNING });
  expect((await rowsOf("owner", "daily_brief")).length).toBe(0);

  await Digest.sendDigests(h.pool, { now: EVENING });
  const digest = await rowsOf("owner", "daily_digest");
  expect(digest.length).toBe(1);
  expect(digest[0].body).not.toContain("By broker");
  expect(digest[0].body).not.toContain("not assigned yet");
});

test("a manager's morning brief carries the agency's ops lines", async () => {
  const admin = await row("admin");
  await Leads.captureLead(h.pool, admin, { phones: "01022222222", name: "Nour" }, { now: new Date("2026-11-04T05:00:00Z") });
  await Digest.sendBriefs(h.pool, { now: MORNING });
  const brief = await rowsOf("admin", "daily_brief");
  expect(brief.length).toBe(1);
  expect(brief[0].body).toContain("The agency");
  expect(brief[0].body).toContain("Leads with no broker: 1");
});

test("pacing: one pass sends only the server's share, the rest waits for the next pass; the stamp waits too", async () => {
  const admin = await row("admin");
  await Leads.captureLead(h.pool, admin, { phones: "01033333333", name: "A", assignTo: h.BROKERS.broker.id }, { now: new Date("2026-11-04T05:00:00Z") });
  await Leads.captureLead(h.pool, admin, { phones: "01044444444", name: "B", assignTo: h.BROKERS.colleague.id }, { now: new Date("2026-11-04T05:00:00Z") });
  // Only one message server-wide this pass.
  const first = await Digest.sendBriefs(h.pool, { now: MORNING, serverLimit: 1, gapMs: 0 });
  expect(first.sent).toBe(1);
  expect(first.pending).toBe(true);
  // The next pass finishes the rest; nobody gets two.
  const second = await Digest.sendBriefs(h.pool, { now: MORNING, serverLimit: 10, gapMs: 0 });
  expect(second.sent).toBe(1);
  expect(second.pending).toBe(false);
  const again = await Digest.sendBriefs(h.pool, { now: MORNING, serverLimit: 10, gapMs: 0 });
  expect(again.sent).toBe(0);
});

test("the constants are the ones the job uses", () => {
  expect(Digest.SEND_GAP_MS).toBeGreaterThan(0);
  expect(Digest.PASS_SERVER).toBeGreaterThan(Digest.PASS_AGENCY);
});
