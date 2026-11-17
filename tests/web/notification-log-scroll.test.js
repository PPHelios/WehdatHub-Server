// tests/web/notification-log-scroll.test.js — the notification log table scrolls sideways inside its box on a phone
// (QA 2026-11-17: the page itself overflowed at 390 px).
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

test("the log table sits in a scroll box", async () => {
  const a = await signIn(h, "admin");
  const res = await a.agent.get("/app/notifications/log?lang=en");
  expect(res.status).toBe(200);
  expect(res.text).toMatch(/<div class="scroll"><table>/);
});
