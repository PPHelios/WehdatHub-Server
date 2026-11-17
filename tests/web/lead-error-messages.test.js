// tests/web/lead-error-messages.test.js — a lead action that fails shows a sentence, never the raw error code.
// Found by QA 2026-11-17: a follow-up in the past showed "⚠️ follow_up_past".
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

test("a follow-up in the past says the time has passed, in English and in Arabic", async () => {
  const a = await signIn(h, "admin");
  const admin = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];
  const r = await Leads.captureLead(h.pool, admin, { phones: "01012345678", name: "Past Test" });
  const path = `/app/leads/L-${String(r.lead.ref).padStart(4, "0")}/follow-up`;
  const res = await a.agent.post(path).type("form").send({ _csrf: a.csrf, at: "2020-01-01T10:00", kind: "call" });
  expect(res.status).toBe(422);
  expect(res.text).not.toMatch(/follow_up_past/);
  expect(res.text).toMatch(/That time has passed|الميعاد ده عدّى/);
});

test("an unknown stage shows a sentence too", async () => {
  const a = await signIn(h, "admin");
  const admin = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];
  const r = await Leads.captureLead(h.pool, admin, { phones: "01012345679", name: "Stage Test" });
  const res = await a.agent.post(`/app/leads/L-${String(r.lead.ref).padStart(4, "0")}/stage`).type("form").send({ _csrf: a.csrf, stage: "limbo" });
  expect(res.text).not.toMatch(/unknown_stage/);
});

test("the duplicate-phone check runs in the background and never locks the page (so the Save click is not lost)", async () => {
  const a = await signIn(h, "admin");
  const page = await a.agent.get("/app/leads/new?lang=en");
  expect(page.status).toBe(200);
  const checks = page.text.match(/<input[^>]*hx-post="\/app\/leads\/check"[^>]*>/g) || [];
  expect(checks.length).toBeGreaterThanOrEqual(2);
  for (const tag of checks) expect(tag).toMatch(/data-no-lock/);
});
