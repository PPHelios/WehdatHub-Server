// tests/web/owner-test-cases.test.js — A nightly finding can be kept as a test case (once per text, listed, removable), and the
// CRM owner's board offers Yesterday · 7 days · Month.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const { resetConfig } = require("../../config");
const AdminBoard = require("../../services/adminBoard");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
  resetConfig();
});
afterEach(() => {
  delete process.env.OWNER_BROKER_IDS;
  resetConfig();
});
afterAll(closeHarness);

const FLAG = JSON.stringify({ zero: true, bad_ids: [], disagree: [], missed_ids: [] });
const post = (s, path, body) => s.agent.post(path).type("form").send({ _csrf: s.csrf, ...body });

test("the board offers Yesterday, 7 days and Month, and no other period", () => {
  expect(AdminBoard.PERIODS).toEqual([1, 7, 30]);
});

test("the board shows the three period tabs", async () => {
  const owner = await signIn(h, "admin");
  const text = (await owner.agent.get("/app/owner/board?tab=overview&lang=en")).text;
  for (const d of [1, 7, 30]) expect(text).toContain(`data-period="${d}"`);
  expect(text).not.toContain('data-period="90"');
});

test("a nightly finding becomes a test case once, is listed, and can be removed", async () => {
  await h.query("INSERT INTO search_log (agency_id, channel, query_text, source, total, audit) VALUES ($1, 'web', 'villa maadi', 'parser', 0, $2::jsonb)", [h.AGENCY_A, FLAG]);
  const logId = (await h.query("SELECT id FROM search_log WHERE query_text = 'villa maadi'"))[0].id;
  const owner = await signIn(h, "admin");

  const row = (await owner.agent.get("/app/owner/searches?view=audit&period=month&lang=en")).text;
  expect(row).toContain("Add as test case");

  expect((await post(owner, `/app/owner/searches/audit/${logId}`, { decision: "addcase", back: "/app/owner/searches" })).status).toBe(303);
  await post(owner, `/app/owner/searches/audit/${logId}`, { decision: "addcase", back: "/app/owner/searches" });
  expect((await h.query("SELECT count(*)::int AS n FROM search_test_cases"))[0].n).toBe(1);

  const list = (await owner.agent.get("/app/owner/searches?view=cases&lang=en")).text;
  expect(list).toContain("villa maadi");
  const caseId = (await h.query("SELECT id FROM search_test_cases"))[0].id;
  await post(owner, `/app/owner/searches/cases/${caseId}`, { decision: "remove", back: "/app/owner/searches?view=cases" });
  expect((await h.query("SELECT count(*)::int AS n FROM search_test_cases"))[0].n).toBe(0);
});

test("only the CRM owner adds or removes test cases", async () => {
  await h.query("INSERT INTO search_log (agency_id, channel, query_text, source, total, audit) VALUES ($1, 'web', 'x', 'parser', 0, $2::jsonb)", [h.AGENCY_A, FLAG]);
  const logId = (await h.query("SELECT id FROM search_log WHERE query_text = 'x'"))[0].id;
  const broker = await signIn(h, "broker");
  expect((await post(broker, `/app/owner/searches/audit/${logId}`, { decision: "addcase" })).status).toBe(404);
  expect((await h.query("SELECT count(*)::int AS n FROM search_test_cases"))[0].n).toBe(0);
});
