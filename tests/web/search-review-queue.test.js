// tests/web/search-review-queue.test.js — The search review in three tabs (patch 5 deferred items): teaching a word with a preview, a
// word that would break a passing test case is blocked, rule problems stay as failing cases, vocabulary edit/remove, re-check gate.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const { resetConfig } = require("../../config");
const Q = require("../../domain/searchQuery");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
  resetConfig();
  Q.setAliases([]);
});
afterEach(() => {
  delete process.env.OWNER_BROKER_IDS;
  resetConfig();
  Q.setAliases([]);
});
afterAll(closeHarness);

const FLAG = JSON.stringify({ zero: true, bad_ids: [], disagree: [], missed_ids: [] });
const post = (s, path, body) => s.agent.post(path).type("form").send({ _csrf: s.csrf, ...body });
const BACK = "/app/owner/searches?view=queue";

test("teaching a word previews first, saves as approved, and the next search reads it", async () => {
  await h.query("INSERT INTO search_log (agency_id, channel, query_text, source, total, audit) VALUES ($1, 'web', 'بيتزا للبيع', 'parser', 0, $2::jsonb)", [h.AGENCY_A, FLAG]);
  const owner = await signIn(h, "admin");
  expect(Q.fallbackParse("بيتزا").filters.property_types).toEqual([]);

  const pre = await post(owner, "/app/owner/searches/teach", { decision: "preview", text: "بيتزا للبيع", term: "بيتزا", kind: "type", target: "فيلا", back: BACK });
  expect(pre.headers.location).toContain("note=preview");
  expect(pre.headers.location).toContain("reading%20changes");
  expect((await h.query("SELECT count(*)::int AS n FROM search_aliases WHERE term = 'بيتزا'"))[0].n).toBe(0);

  const saved = await post(owner, "/app/owner/searches/teach", { decision: "save", text: "بيتزا للبيع", term: "بيتزا", kind: "type", target: "فيلا", back: BACK });
  expect(saved.headers.location).toContain("note=saved");
  expect((await h.query("SELECT status, source FROM search_aliases WHERE term = 'بيتزا'"))[0]).toEqual({ status: "approved", source: "manual" });
  expect(Q.fallbackParse("بيتزا").filters.property_types).toEqual(["villa"]);
});

test("the new word kinds (furnishing, finishing, sale or rent) are accepted", async () => {
  const owner = await signIn(h, "admin");
  for (const [term, kind, target] of [["مفروشه", "furnishing", "مفروش"], ["سوبر لوكس", "finishing", "تشطيب كامل"], ["للتمليك", "listing_type", "بيع"]]) {
    const r = await post(owner, "/app/owner/searches/teach", { decision: "save", text: term, term, kind, target, back: BACK });
    expect(r.headers.location).toContain("note=saved");
  }
  expect((await h.query("SELECT count(*)::int AS n FROM search_aliases WHERE kind IN ('furnishing', 'finishing', 'listing_type')"))[0].n).toBe(3);
});

test("a word that would break a passing test case is blocked and not saved", async () => {
  const owner = await signIn(h, "admin");
  const text = "شقة 3 غرف";
  const expected = { property_types: Q.fallbackParse(text).filters.property_types };
  expect(expected.property_types.length).toBeGreaterThan(0);
  await post(owner, "/app/owner/searches/queue/case", { text, expected: JSON.stringify(expected), back: BACK });
  const blocked = await post(owner, "/app/owner/searches/teach", { decision: "save", text: "x", term: "شقة", kind: "type", target: "فيلا", back: BACK });
  expect(blocked.headers.location).toContain("note=blocked");
  expect((await h.query("SELECT count(*)::int AS n FROM search_aliases WHERE term = 'شقة' AND status = 'approved'"))[0].n).toBe(0);
});

test("a rule problem is kept as a failing case; it cannot be closed by re-check until the rule passes", async () => {
  const owner = await signIn(h, "admin");
  await h.query("INSERT INTO search_log (agency_id, channel, query_text, source, total, audit) VALUES ($1, 'web', 'made up rule problem 77', 'parser', 0, $2::jsonb)", [h.AGENCY_A, FLAG]);
  const bad = await post(owner, "/app/owner/searches/queue/case", { text: "made up rule problem 77", expected: "{not json", back: BACK });
  expect(bad.headers.location).toContain("note=bad_json");
  await post(owner, "/app/owner/searches/queue/case", { text: "made up rule problem 77", expected: JSON.stringify({ price_max: 424242 }), back: BACK });

  const cases = (await owner.agent.get("/app/owner/searches?view=cases&lang=en")).text;
  expect(cases).toMatch(/data-case="[^"]+" data-pass="0"/);
  expect(cases).toContain("rule problem");
  expect(cases).toContain('data-failing="1"');

  const gate = await post(owner, "/app/owner/searches/queue/recheck", { text: "made up rule problem 77", back: BACK });
  expect(gate.headers.location).toContain("note=notyet");
  expect((await h.query("SELECT count(*)::int AS n FROM search_log WHERE query_text = 'made up rule problem 77' AND audit_resolved_at IS NULL"))[0].n).toBe(1);
});

test("a search with a passing case is closed by re-check; Dismiss closes without one", async () => {
  const owner = await signIn(h, "admin");
  await h.query("INSERT INTO search_log (agency_id, channel, query_text, source, total, audit) VALUES ($1, 'web', 'شقة للبيع', 'parser', 0, $2::jsonb), ($1, 'web', 'dismiss me', 'parser', 0, $2::jsonb)", [h.AGENCY_A, FLAG]);
  await post(owner, "/app/owner/searches/queue/case", { text: "شقة للبيع", back: BACK });
  const ok = await post(owner, "/app/owner/searches/queue/recheck", { text: "شقة للبيع", back: BACK });
  expect(ok.headers.location).toContain("note=rechecked");
  expect((await h.query("SELECT count(*)::int AS n FROM search_log WHERE query_text = 'شقة للبيع' AND audit_resolved_at IS NULL"))[0].n).toBe(0);
  await post(owner, "/app/owner/searches/queue/dismiss", { text: "dismiss me", back: BACK });
  expect((await h.query("SELECT count(*)::int AS n FROM search_log WHERE query_text = 'dismiss me' AND audit_resolved_at IS NULL"))[0].n).toBe(0);
});

test("the vocabulary tab lists approved words, which can be edited and removed", async () => {
  const owner = await signIn(h, "admin");
  await post(owner, "/app/owner/searches/teach", { decision: "save", text: "x", term: "زمبوره", kind: "feature", target: "حمام سباحه", back: BACK });
  const id = (await h.query("SELECT id FROM search_aliases WHERE term = 'زمبوره'"))[0].id;
  const tab = (await owner.agent.get("/app/owner/searches?view=vocab&lang=en")).text;
  expect(tab).toContain(`data-alias="${id}" data-status="approved"`);
  await post(owner, `/app/owner/searches/words/${id}`, { decision: "save", term: "زمبورا", kind: "feature", target: "حمام سباحه", back: "/app/owner/searches?view=vocab" });
  expect((await h.query("SELECT term FROM search_aliases WHERE id = $1", [id]))[0].term).toBe("زمبورا");
  await post(owner, `/app/owner/searches/words/${id}`, { decision: "remove", back: "/app/owner/searches?view=vocab" });
  expect((await h.query("SELECT status FROM search_aliases WHERE id = $1", [id]))[0].status).toBe("rejected");
  expect((await owner.agent.get("/app/owner/searches?view=vocab&lang=en")).text).not.toContain(`data-alias="${id}"`);
});

test("the old tab links still open the queue or the vocabulary, and a broker is refused", async () => {
  const owner = await signIn(h, "admin");
  expect((await owner.agent.get("/app/owner/searches?view=audit&lang=en")).text).toContain('data-view-body="queue"');
  expect((await owner.agent.get("/app/owner/searches?view=words&lang=en")).text).toContain('data-view-body="vocab"');
  expect((await (await signIn(h, "broker")).agent.post("/app/owner/searches/teach").type("form").send({ _csrf: "x" })).status).toBeGreaterThanOrEqual(400);
});
