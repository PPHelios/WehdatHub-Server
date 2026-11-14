// tests/web/owner-review-fixes.test.js — New words can be corrected (spelling, kind, meaning) before approval; reports say
// what to do; the owner page has one search review link; private-data grants last 60 days.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const { resetConfig } = require("../../config");
const Review = require("../../services/searchReview");
const Privacy = require("../../services/unitPrivacy");

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

const post = (s, path, body) => s.agent.post(path).type("form").send({ _csrf: s.csrf, ...body });

test("a pending word can be corrected: spelling, kind (compound) and meaning", async () => {
  await h.query("INSERT INTO search_aliases (term, target, kind, status) VALUES ('مفيده', 'شقه', 'type', 'pending')");
  const row = (await h.query("SELECT id FROM search_aliases WHERE term = 'مفيده'"))[0];
  const owner = await signIn(h, "admin");
  expect((await post(owner, `/app/owner/searches/words/${row.id}`, { decision: "save", term: "ميفيدا", kind: "place", target: "ميفيدا", back: "/app/owner/searches" })).status).toBe(303);
  const [w] = await h.query("SELECT term, kind, target, status FROM search_aliases WHERE id = $1", [row.id]);
  expect(w).toMatchObject({ term: "ميفيدا", kind: "place", target: "ميفيدا", status: "pending" });
});

test("a word cannot be saved with an unknown kind, an empty spelling, or as a duplicate", async () => {
  await h.query("INSERT INTO search_aliases (term, target, kind, status) VALUES ('تكيفات', 'تكييفات', 'feature', 'pending'), ('x', 'y', 'type', 'pending')");
  const [a] = await h.query("SELECT id, term FROM search_aliases WHERE term = 'تكيفات'");
  expect(await Review.editWord(h.pool, a.id, { term: "x", kind: "type", target: "y" })).toEqual({ error: "duplicate" });
  expect(await Review.editWord(h.pool, a.id, { term: "", kind: "type", target: "y" })).toEqual({ error: "invalid" });
  expect(await Review.editWord(h.pool, a.id, { term: "z", kind: "town", target: "y" })).toEqual({ error: "invalid" });
  expect((await h.query("SELECT term FROM search_aliases WHERE id = $1", [a.id]))[0].term).toBe("تكيفات");
});

test("the queue shows a reported search once with Teach word, Re-check and Dismiss", async () => {
  await h.query("INSERT INTO search_log (agency_id, channel, query_text, source, total) VALUES ($1, 'web', 'مفيده', 'parser', 0)", [h.AGENCY_A]);
  const logId = (await h.query("SELECT id FROM search_log WHERE query_text = 'مفيده'"))[0].id;
  await h.query("INSERT INTO search_reports (search_log_id, agency_id, broker_id, note) VALUES ($1, $2, $3, 'مش لاقي')", [logId, h.AGENCY_A, h.BROKERS.broker.id]);
  const owner = await signIn(h, "admin");
  const text = (await owner.agent.get("/app/owner/searches?view=queue&lang=en")).text;
  expect(text).toContain("Re-check");
  expect(text).toContain("Dismiss");
  expect(text).toContain("report ×1");
  expect(text).toContain("Vocabulary");
});

test("the owner page has one search review link", async () => {
  const owner = await signIn(h, "admin");
  const text = (await owner.agent.get("/app/owner?lang=en")).text;
  expect(text.replace(/<nav class="sidemenu"[\s\S]*?<\/nav>/, "").match(/href="\/app\/owner\/searches"/g) || []).toHaveLength(1);
});

test("private-data grants last 60 days", () => {
  expect(Privacy.GRANT_DAYS).toBe(60);
});
