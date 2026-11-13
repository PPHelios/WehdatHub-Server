// tests/web/search-learning.test.js — Phase 3: words in the database, learning from the AI, the quiet AI read, the nightly check.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Q = require("../../domain/searchQuery");
const Vocab = require("../../services/searchVocab");
const Learn = require("../../services/searchLearn");
const Shadow = require("../../services/searchShadow");
const Audit = require("../../services/searchAudit");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  Vocab.reset();
  Q.setAliases([]);
});
afterAll(closeHarness);

const aliasRows = () => h.query("SELECT * FROM search_aliases WHERE source <> 'seed' ORDER BY created_at");
const pairOf = (text, aiFilters) => {
  const local = Q.fallbackParse(text);
  return { local, ai: { filters: { ...Q.emptyFilters(), ...aiFilters } } };
};

test("seeded spellings are loaded into the parser from the database", async () => {
  await h.query("INSERT INTO search_aliases (term, target, kind, status, source) VALUES ('بيتزا', 'فيلا', 'type', 'approved', 'manual')");
  expect(Q.fallbackParse("بيتزا").filters.property_types).toEqual([]);
  expect(await Vocab.refresh(h.pool)).toBeGreaterThan(1);
  expect(Q.fallbackParse("بيتزا").filters.property_types).toEqual(["villa"]);
  expect((await h.query("SELECT COUNT(*)::int AS n FROM search_aliases WHERE source = 'seed'"))[0].n).toBeGreaterThan(0);
});

test("a word the AI explained is proposed once per search it agrees on, and waits for the owner", async () => {
  const { local, ai } = pairOf("شقه كبيره في التجمع", { property_types: ["villa"], features: ["terrace"] });
  // Two things were added, so nothing is guessed.
  expect(await Learn.learn(h.pool, { text: "x", local, ai })).toBeNull();
  const one = pairOf("منزل في الشيخ زايد", { property_types: ["villa"], places: Q.fallbackParse("الشيخ زايد").filters.places });
  const got = await Learn.learn(h.pool, { text: "منزل في الشيخ زايد", local: one.local, ai: one.ai });
  expect(got).toMatchObject({ term: "منزل", target: "فيلا", kind: "type" });
  await Learn.learn(h.pool, { text: "منزل", local: one.local, ai: one.ai });
  const [row] = await aliasRows();
  expect(row).toMatchObject({ status: "pending", agreed: 2 });
  // Not used until approved.
  await Vocab.refresh(h.pool);
  expect(Q.fallbackParse("منزل").filters.property_types).toEqual([]);
  expect(await Learn.decide(h.pool, row.id, true)).toEqual({ ok: true });
  expect(Q.fallbackParse("منزل").filters.property_types).toEqual(["villa"]);
});

test("auto-approval waits a month of searches, then needs five agreements", async () => {
  const one = pairOf("منزل", { property_types: ["villa"] });
  for (let i = 0; i < 5; i++) await Learn.learn(h.pool, { text: "منزل", local: one.local, ai: one.ai });
  await h.query("INSERT INTO search_log (agency_id, channel, query_text, source) SELECT id, 'web', 'x', 'parser' FROM agencies LIMIT 1");
  expect(await Learn.autoApprove(h.pool, new Date())).toBe(0);
  await h.query("UPDATE search_log SET created_at = now() - interval '31 days'");
  expect(await Learn.autoApprove(h.pool, new Date())).toBe(1);
  expect((await aliasRows())[0]).toMatchObject({ status: "approved", decided_by: "auto" });
});

test("the quiet AI read keeps the AI's filters on the row, spends no agency credits, and respects the daily budget", async () => {
  process.env.SEARCH_SHADOW_AI = "true";
  process.env.SEARCH_SHADOW_DAILY_MAX = "1";
  try {
    h.AI.respond((c) => (c.operation === "search_parse" ? { intent: "search", language: "ar", filters: { property_types: ["villa"], bedrooms_min: 4 } } : null));
    const text = "فيلا 4 غرف";
    const parse = { source: "parser", local: Q.fallbackParse(text), ai: null };
    const { rows } = await h.pool.query("SELECT id FROM agencies LIMIT 1");
    const log = await h.pool.query("INSERT INTO search_log (agency_id, channel, query_text, source, local_filters) VALUES ($1, 'web', $2, 'parser', '{}') RETURNING id", [rows[0].id, text]);
    await Shadow.observe(h.pool, h.AI, { logId: log.rows[0].id, text, parse });
    const [row] = await h.query("SELECT ai_filters FROM search_log WHERE id = $1", [log.rows[0].id]);
    expect(row.ai_filters.bedrooms_min).toBe(4);
    const calls = h.AI.calls.length;
    await Shadow.observe(h.pool, h.AI, { logId: log.rows[0].id, text, parse }); // budget of 1 is used
    expect(h.AI.calls.length).toBe(calls);
  } finally {
    delete process.env.SEARCH_SHADOW_AI;
    delete process.env.SEARCH_SHADOW_DAILY_MAX;
  }
});

test("the nightly check finds zero results, wrong results, disagreements and missed units", async () => {
  const wrong = await h.insertListing({ code: "W1", compound: "Hyde Park", bedrooms: 2, area_value: 100, price_value: 5e6 });
  const missed = await h.insertListing({ code: "M1", compound: "Hyde Park", bedrooms: 4, area_value: 300, price_value: 9e6, property_type: "villa" });
  const { rows } = await h.pool.query("SELECT agency_id FROM listings WHERE id = $1", [missed.id]);
  const agency = rows[0].agency_id;
  const f = (o) => JSON.stringify({ ...Q.emptyFilters(), ...o });
  await h.query(
    `INSERT INTO search_log (agency_id, channel, query_text, source, local_filters, ai_filters, used_filters, total, result_ids) VALUES
       ($1, 'web', 'zero', 'parser', $2, NULL, $2, 0, '{}'),
       ($1, 'web', 'wrong', 'parser', $3, NULL, $3, 1, ARRAY[$4]::uuid[]),
       ($1, 'web', 'differ', 'parser', $5, $6, $5, 0, '{}')`,
    [agency, f({ bedrooms_min: 9 }), f({ bedrooms_min: 3 }), wrong.id, f({ property_types: ["apartment"] }), f({ property_types: ["villa"] })]
  );
  const c = await Audit.run(h.pool, { now: new Date(Date.now() + 1000) });
  expect(c).toMatchObject({ searches: 3, zero: 2, wrong: 1, disagree: 1, missed: 1 });
  const text = await Audit.summary(h.pool, c);
  expect(text).toMatch(/3 searches/);
  expect((await h.query("SELECT COUNT(*)::int AS n FROM search_log WHERE audit IS NULL"))[0].n).toBe(0);
  expect((await Audit.run(h.pool, { now: new Date(Date.now() + 2000) })).searches).toBe(0); // checked once
});

test("only the CRM owner opens the review page and decides words", async () => {
  const one = pairOf("منزل", { property_types: ["villa"] });
  await Learn.learn(h.pool, { text: "منزل", local: one.local, ai: one.ai });
  const { agent: broker, csrf } = await signIn(h, "broker");
  expect((await broker.get("/app/owner/searches")).status).toBe(404);
  const row = (await aliasRows())[0];
  expect((await broker.post(`/app/owner/searches/words/${row.id}`).type("form").send({ _csrf: csrf, decision: "approve" })).status).toBe(404);
  expect((await aliasRows())[0].status).toBe("pending");
});

test("a feature the owner switched off is marked for graying out on the web, and its Telegram button is hidden", async () => {
  const Switches = require("../../services/aiSwitches");
  const { agent, csrf } = await signIn(h, "admin");
  expect((await agent.get("/app/units/new")).text).not.toContain("data-ai-off=");
  await h.query("UPDATE agencies SET crm_settings = crm_settings || $1::jsonb", [JSON.stringify({ ai_switches: { tabs: { voice: false }, features: { unit_fill: false } } })]);
  Switches.clearCache();
  const page = (await agent.get("/app/units/new")).text;
  expect(page).toMatch(/data-ai-off="[^"]*unit_fill/);
  expect(page).toMatch(/data-ai-off="[^"]*voice_unit_add/);
  expect(page).toContain('data-ai="unit_fill"');
  const Bot = require("../../lib/search");
  expect(Bot.feedbackButtons("l1", "parser", "en", { aiOff: true }).map((b) => b.id)).toEqual(["sx:bad:l1"]);
  expect(Bot.feedbackButtons("l1", "parser", "en").map((b) => b.id)).toEqual(["sx:bad:l1", "sx:ai:l1"]);
  void csrf;
});

test("the nightly check names the filter that emptied a search and finds units the plain check says were missed", async () => {
  const a = await h.insertListing({ code: "V1", compound: "Hyde Park", bedrooms: 4, area_value: 300, price_value: 9e6, property_type: "villa" });
  const b = await h.insertListing({ code: "V2", compound: "Hyde Park", bedrooms: 5, area_value: 320, price_value: 8e6, property_type: "villa" });
  const { rows } = await h.pool.query("SELECT agency_id FROM listings WHERE id = $1", [a.id]);
  const agency = rows[0].agency_id;
  const f = (o) => JSON.stringify({ ...Q.emptyFilters(), ...o });
  await h.query(
    `INSERT INTO search_log (agency_id, channel, query_text, source, used_filters, total, result_ids) VALUES
       ($1, 'app', 'zero', 'parser', $2, 0, '{}'),
       ($1, 'app', 'one of two', 'parser', $3, 1, ARRAY[$4]::uuid[])`,
    [agency, f({ property_types: ["villa"], bedrooms_min: 9 }), f({ property_types: ["villa"], bedrooms_min: 4 }), a.id]
  );
  const c = await Audit.run(h.pool, { now: new Date(Date.now() + 1000) });
  expect(c).toMatchObject({ searches: 2, zero: 1, core_missed: 1 });
  const zero = (await h.query("SELECT audit FROM search_log WHERE query_text = 'zero'"))[0].audit;
  expect(zero.drop_one).toEqual({ bedrooms: 2 });
  const miss = (await h.query("SELECT audit FROM search_log WHERE query_text = 'one of two'"))[0].audit;
  expect(miss.core_missed_ids).toEqual([b.id]);
});
