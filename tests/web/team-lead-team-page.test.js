// tests/web/team-lead-team-page.test.js — a team lead opens Team on the website and sees their own team, read only; a broker is refused.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("manager");
  await h.seedBroker("colleague");
  await h.query("UPDATE brokers SET role = 'team_lead' WHERE id = $1", [h.BROKERS.colleague.id]);
  await h.query("UPDATE brokers SET team_lead_id = $1 WHERE id = $2", [h.BROKERS.colleague.id, h.BROKERS.broker.id]);
});
afterAll(closeHarness);

test("a team lead sees their own team on /app/team, with no management forms", async () => {
  const { agent } = await signIn(h, "colleague");
  const r = await agent.get("/app/team?lang=en");
  expect(r.status).toBe(200);
  expect(r.text).toContain(h.BROKERS.broker.name);
  expect(r.text).not.toContain(h.BROKERS.manager.name);
  expect(r.text).not.toContain("/app/team/invite");
});

test("a broker is still refused", async () => {
  const { agent } = await signIn(h, "broker");
  expect((await agent.get("/app/team")).status).toBe(403);
});
