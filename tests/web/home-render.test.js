// Regression: GET /app/ crashed with "req is not defined" (todayPage used req outside the handler).
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");

jest.setTimeout(60000);

let h;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

test("signed-in /app/ renders the home page (200)", async () => {
  const { agent } = await signIn(h, "broker");
  const r = await agent.get("/app/");
  expect(r.status).toBe(200);
  expect(r.text).toContain("data-today");
});

test("signed-out /app/ does not crash (login page or redirect, never 500)", async () => {
  const r = await request(h.app.app).get("/app/");
  expect(r.status).toBeLessThan(500);
});
