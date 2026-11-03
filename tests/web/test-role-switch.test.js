// tests/web/test-role-switch.test.js — the test switch on the website: the test number changes its own role; others get 403
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");

jest.setTimeout(60000);

let h;
const saved = { ...process.env };
beforeEach(async () => {
  h = await createHarness();
  process.env.TEST_SWITCH_PHONE = h.BROKERS.broker.phone;
  process.env.TEST_SWITCH_AGENCY_ID = h.BROKERS.broker.agency_id;
});
afterEach(() => {
  process.env = { ...saved };
});
afterAll(closeHarness);

test("the test number changes its own role, on the website and in Telegram alike", async () => {
  const { agent, csrf } = await signIn(h, h.BROKERS.broker);
  const page = await agent.get("/app/units");
  expect(page.text).toContain("data-test-role");
  const res = await agent.post("/app/test-role").type("form").send({ role: "manager", _csrf: csrf });
  expect(res.status).toBe(303);
  const { rows } = await h.pool.query("SELECT role FROM brokers WHERE id = $1", [h.BROKERS.broker.id]);
  expect(rows[0].role).toBe("manager");
});

test("another broker cannot use the switch, and the switch is not shown to them", async () => {
  const { agent, csrf } = await signIn(h, h.BROKERS.colleague);
  const page = await agent.get("/app/units");
  expect(page.text).not.toContain("data-test-role");
  const res = await agent.post("/app/test-role").type("form").send({ role: "owner", _csrf: csrf });
  expect(res.status).toBe(403);
});
