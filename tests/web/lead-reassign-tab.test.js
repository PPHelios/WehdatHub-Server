// tests/web/lead-reassign-tab.test.js — The lead page's last tab (reassign and merge) shows to managers only.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];

test("the reassign tab is shown to managers only", async () => {
  const admin = await row("admin");
  const r = await Leads.captureLead(h.pool, admin, { phones: "01012345678", name: "Sara", assignTo: h.BROKERS.broker.id });
  const path = `/app/leads/${r.lead.ref}`;

  const { agent: m } = await signIn(h, "admin");
  const manager = await m.get(path);
  expect(manager.status).toBe(200);
  expect(manager.text).toContain('id="lt-more"');
  expect(manager.text).toContain("Reassign");
  expect(manager.text).not.toContain(">More<");

  const { agent: b } = await signIn(h, "broker");
  const broker = await b.get(path);
  expect(broker.status).toBe(200);
  expect(broker.text).not.toContain('id="lt-more"');
  expect(broker.text).not.toContain("Reassign");
  expect(broker.text).not.toContain('id="assign"');
});
