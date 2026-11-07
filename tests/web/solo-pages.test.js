// tests/web/solo-pages.test.js — A one-person account sees "your account" instead of "the company" in fixed Arabic phrases.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Credits = require("../../lib/credits");

jest.setTimeout(60000);
let h;
beforeEach(async () => {
  Credits.clearSoloCache();
  h = await createHarness();
  await h.seedBroker("manager");
});
afterAll(closeHarness);

test("a team sees 'لوحة الشركة'; the same agency down to one user sees 'لوحتي'", async () => {
  const { agent } = await signIn(h, "manager");
  const team = await agent.get("/app/dashboard");
  expect(team.text).toContain("لوحة الشركة");
  await h.query("UPDATE brokers SET is_active = false WHERE agency_id = $1 AND id <> $2", [h.BROKERS.manager.agency_id, h.BROKERS.manager.id]);
  Credits.clearSoloCache();
  const solo = await agent.get("/app/dashboard");
  expect(solo.text).not.toContain("لوحة الشركة");
  expect(solo.text).toContain("لوحتي");
});
