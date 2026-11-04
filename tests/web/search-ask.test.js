// tests/web/search-ask.test.js — a word nobody knows is never dropped silently: the web page and the bot ask, offer
// "search without it", and the search log keeps what was asked; AI-first keeps both readings.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness, textOf } = require("../harness/app");
const { signIn } = require("../harness/web");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  await h.insertListing({ code: "MV-3A", compound: "ماونتن فيو آي سيتي", bedrooms: 3, area_value: 160, price_value: 9e6 });
});
afterAll(closeHarness);
afterEach(() => {
  process.env.SEARCH_AI_FIRST = "false";
});

const logs = () => h.query("SELECT * FROM search_log ORDER BY created_at, id");

describe("web", () => {
  test("an unknown place word is asked about, not dropped; 'search without it' shows the units and says what was left out", async () => {
    const { agent } = await signIn(h, "broker");
    const ask = await agent.get("/app/search").query({ q: "Mountain View 3 bedrooms dusit" });
    expect(ask.text).toContain("data-ask-unknown");
    expect(ask.text).toContain("dusit");
    expect(ask.text).toContain("data-search-without");
    expect(ask.text).not.toContain('class="results"');
    const [row] = await logs();
    expect(row.asked).toEqual(["dusit"]);
    expect(row.total).toBe(0);

    const go = await agent.get("/app/search").query({ q: "Mountain View 3 bedrooms dusit", drop: "1" });
    expect(go.text).not.toContain("data-ask-unknown");
    expect(go.text).toContain("data-ignored");
    expect(go.text).toContain("MV-3A");
  });

  test("a close spelling is read as the place and said so", async () => {
    await h.insertListing({ code: "MV-9", compound: "Mivida", bedrooms: 3, area_value: 150, price_value: 7e6 });
    const { agent } = await signIn(h, "broker");
    const page = await agent.get("/app/search").query({ q: "شقة في مفيده 3 نوم" });
    expect(page.text).not.toContain("data-ask-unknown");
    expect(page.text).toContain("data-guesses");
    expect(page.text).toContain("MV-9");
    const [row] = await logs();
    expect(row.guesses).toEqual([{ typed: "مفيده", as: "ميفيدا" }]);
  });

  test("AI-first: the AI reads a sure search, both readings and the differences are kept", async () => {
    process.env.SEARCH_AI_FIRST = "true";
    h.AI.respond((c) => (c.operation === "search_parse" ? { intent: "search", language: "en", filters: { property_types: ["apartment"], bedrooms_min: 3, compound: "Mountain View", price_max: 9500000 } } : null));
    const { agent } = await signIn(h, "broker");
    await agent.get("/app/search").query({ q: "Mountain View 3 bedrooms" });
    const [row] = await logs();
    expect(row.source).toBe("ai");
    expect(row.local_filters).toBeTruthy();
    expect(row.ai_filters.price_max).toBe(9500000);
    expect(row.disagree).toEqual(expect.arrayContaining(["price_max", "property_types"]));
  });

  test("the AI is down and a number is left: ask, never search as if it were not there", async () => {
    process.env.SEARCH_AI_FIRST = "true";
    h.AI.respond(() => new Error("down"));
    const { agent } = await signIn(h, "broker");
    const page = await agent.get("/app/search").query({ q: "شقة 3 نوم في ماونتن فيو 85" });
    expect(page.text).toContain("data-ask-unknown");
    expect(page.text).toContain("85");
    const [row] = await logs();
    expect(row.source).toBe("fallback");
    expect(row.ai_error).toBeTruthy();
    expect(row.asked).toEqual(["85"]);
  });
});

describe("bot", () => {
  test("an unknown word gets a question with a 'search without it' button, which then searches", async () => {
    const reply = await h.text("broker", "Mountain View 3 bedrooms dusit");
    const out = textOf(reply);
    expect(out).toMatch(/dusit/);
    const btn = reply.flatMap((r) => r.buttons || []).find((b) => /^sx:skip:/.test(b.id));
    expect(btn).toBeTruthy();
    const after = textOf(await h.tap("broker", btn.id));
    expect(after).toContain("MV-3A");
    expect(after).toMatch(/dusit/); // the words left out are named
  });
});
