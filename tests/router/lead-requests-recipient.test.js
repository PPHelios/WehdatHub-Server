// tests/router/lead-requests-recipient.test.js — "Ask a manager" and "Ask the owner" are separate requests: one open per
// broker per lead; a manager does not see requests addressed to the owner; handling closes only the actor's role.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const Leads = require("../../services/leads");

jest.setTimeout(60000);

let h;
const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const open = () => h.query("SELECT to_role, broker_id, note FROM lead_requests WHERE handled_at IS NULL ORDER BY created_at");

beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("manager");
  await h.seedBroker("owner");
  await h.seedBroker("colleague");
  await Leads.captureLead(h.pool, await row("broker"), { phones: "01012345678", name: "Sara Req" });
});
afterAll(closeHarness);

test("a broker has one open request per lead; a second person who works the lead has their own", async () => {
  const a = await Leads.flagForManager(h.pool, await row("broker"), "L-0001", "First question", { to: "manager" });
  expect(a.ok).toBe(true);
  const again = await Leads.flagForManager(h.pool, await row("broker"), "L-0001", "Second question", { to: "owner" });
  expect(again.error).toBe("already_flagged");

  // A second person who may work the lead (the manager) has their own open request.
  const b = await Leads.flagForManager(h.pool, await row("manager"), "L-0001", "Their own question", { to: "owner" });
  expect(b.ok).toBe(true);
  expect((await open()).map((r) => r.to_role)).toEqual(["manager", "owner"]);
});

test("a request to the owner is seen by the owner only; a manager's handling leaves it open", async () => {
  await Leads.flagForManager(h.pool, await row("broker"), "L-0001", "Owner decision", { to: "owner" });
  const manager = await row("manager");
  const owner = await row("owner");

  expect(await Leads.openFlags(h.pool, manager)).toEqual([]);
  expect((await Leads.openFlags(h.pool, owner)).map((r) => r.to_role)).toEqual(["owner"]);
  expect(await Leads.flagCount(h.pool, manager)).toBe(0);
  expect(await Leads.flagCount(h.pool, owner)).toBe(1);

  const closedByManager = await Leads.handleFlag(h.pool, manager, "L-0001", "ok");
  expect(closedByManager.unchanged).toBe(true);
  expect((await open()).length).toBe(1);

  const closedByOwner = await Leads.handleFlag(h.pool, owner, "L-0001", "Approved");
  expect(closedByOwner.closed).toBe(1);
  expect(await open()).toEqual([]);
});

test("a manager's handling closes the manager's requests on the lead, with one reply", async () => {
  await Leads.flagForManager(h.pool, await row("broker"), "L-0001", "For a manager", { to: "manager" });
  await Leads.flagForManager(h.pool, await row("manager"), "L-0001", "Also for a manager", { to: "manager" });
  const r = await Leads.handleFlag(h.pool, await row("owner"), "L-0001", "Called the client");
  expect(r.closed).toBe(2);
  const rows = await h.query("SELECT reply FROM lead_requests WHERE handled_at IS NOT NULL");
  expect(rows.map((x) => x.reply)).toEqual(["Called the client", "Called the client"]);
});

test("the request does not change the stage", async () => {
  await Leads.flagForManager(h.pool, await row("broker"), "L-0001", "Only a question", { to: "owner" });
  const [lead] = await h.query("SELECT stage FROM leads");
  expect(lead.stage).toBe("new");
});
