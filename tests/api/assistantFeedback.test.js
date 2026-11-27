// tests/api/assistantFeedback.test.js — assistant miss log (feedback endpoint + automatic clarify capture), the misses report,
// the QA seed and the eval runner.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");
const AI = require("../../lib/ai");

jest.setTimeout(120000);

let h;
beforeEach(async () => {
  h = await createHarness();
  AI.reset();
});
afterAll(() => closeHarness());

const api = () => request(h.app.app);
async function auth(who) {
  const b = h.BROKERS[who];
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const t = (await api().post("/api/v1/auth/code/verify").send({ phone: b.phone, code })).body.token;
  return { Authorization: `Bearer ${t}` };
}
const rows = () => h.query("SELECT * FROM assistant_feedback ORDER BY created_at");

test("feedback: needs sign-in, validates, scrubs, scopes to the agency", async () => {
  expect((await api().post("/api/v1/assistant/feedback").send({ q: "x", verdict: "down" })).status).toBe(401);
  const hdr = await auth("broker");
  const post = (b) => api().post("/api/v1/assistant/feedback").set(hdr).send(b);
  expect((await post({ q: "", verdict: "down" })).status).toBe(422);
  expect((await post({ q: "x", verdict: "up" })).status).toBe(422);
  expect((await post({ q: "x", verdict: "down", reason: "bad" })).status).toBe(422);
  const ok = await post({ q: "show 3 beds for 01012345678 a@b.com", lang: "en", intent: "unit_search", route: "unit_search", verdict: "down", reason: "wrong" });
  expect(ok.status).toBe(204);
  const [row] = await rows();
  expect(row).toMatchObject({ agency_id: h.AGENCY_A, broker_id: h.BROKERS.broker.id, verdict: "down", reason: "wrong", lang: "en", intent: "unit_search", question: "show 3 beds for # @" });
  const rival = await auth("rival");
  await api().post("/api/v1/assistant/feedback").set(rival).send({ q: "other", verdict: "down" });
  expect((await rows()).map((r) => r.agency_id).sort()).toEqual([h.AGENCY_A, h.AGENCY_B].sort());
});

test("an unknown question is saved automatically as clarify; a normal one is not", async () => {
  const hdr = await auth("admin");
  const miss = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "what is the meaning of life 01012345678", mode: "auto" });
  expect(miss.status).toBe(200);
  expect(miss.body.understood?.job).toBe("clarify_question");
  await new Promise((r) => setTimeout(r, 200));
  const r = await rows();
  expect(r).toHaveLength(1);
  expect(r[0]).toMatchObject({ verdict: "clarify", agency_id: h.AGENCY_A });
  expect(r[0].question).not.toMatch(/\d{7}/);
  await h.query("DELETE FROM assistant_feedback");
  await api().post("/api/v1/assistant/query").set(hdr).send({ q: "waiting over 1h", mode: "auto" });
  await new Promise((r) => setTimeout(r, 100));
  expect(await rows()).toHaveLength(0);
});

test("misses report groups the same question", async () => {
  const { misses } = require("../../scripts/assistant-misses");
  for (const q of ["Where is it?", "where is it", "other thing"]) {
    await h.query("INSERT INTO assistant_feedback (agency_id, verdict, question) VALUES ($1, 'clarify', $2)", [h.AGENCY_A, q]);
  }
  const list = await misses(h.pool, { days: 7, agency: h.AGENCY_A });
  expect(list.map((g) => g.count).sort()).toEqual([1, 2]);
});

test("QA seed is re-runnable and the eval runner passes its own checks", async () => {
  await h.seedBroker("manager");
  await h.seedBroker("owner");
  const Seed = require("../../scripts/seed-assistant-qa");
  const first = await Seed.seed(h.pool, h.AGENCY_A);
  const second = await Seed.seed(h.pool, h.AGENCY_A);
  expect(second.leads).toBe(first.leads);
  expect((await h.query("SELECT count(*)::int AS n FROM leads WHERE agency_id = $1 AND name LIKE 'QA %'", [h.AGENCY_A]))[0].n).toBe(first.leads);
  const Leads = require("../../services/leads");
  const mgr = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.manager.id]))[0];
  for (const queue of ["unassigned", "waiting-over-1h", "overdue", "uncontacted"]) expect((await Leads.listLeads(h.pool, mgr, { queue, limit: 1, offset: 0 })).total).toBeGreaterThan(0);
  expect((await h.query("SELECT count(*)::int AS n FROM deals WHERE agency_id = $1", [h.AGENCY_A]))[0].n).toBe(first.deals);
  const { run } = require("../../scripts/assistant-eval");
  const get = async (phone) => (await h.query("SELECT * FROM brokers WHERE phone_normalized = $1", [phone]))[0];
  const actors = { owner: await get(h.BROKERS.owner.phone), manager: await get(h.BROKERS.manager.phone), broker1: await get("201100000003") };
  const fixture = { intents: [{ id: "unassigned", expect: { route: "crm_leads", queueHint: "unassigned" }, questions: ["unassigned leads"] }], unitSearches: [], offTopic: ["hello"] };
  const out = await run({ pool: h.pool, actors, fixture, AI });
  expect(out.results.filter((r) => !r.ok)).toEqual([]);
  expect(out.total).toBe(6);
});
