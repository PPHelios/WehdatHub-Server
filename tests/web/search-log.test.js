// tests/web/search-log.test.js — every search is kept with both readings; the page always says what was understood;
// "Wrong search?" reports it; "Search again with AI" reads it again with the AI.
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
  await h.insertListing({ code: "HP-3", compound: "Hyde Park", bedrooms: 3, area_value: 150, price_value: 8.5e6 });
});
afterAll(closeHarness);

const AI_ANSWER = { intent: "search", language: "ar", filters: { property_types: ["apartment"], bedrooms_min: 3 } };
const logs = () => h.query("SELECT * FROM search_log ORDER BY created_at, id");

describe("the understood block", () => {
  test("a sure reading: words, 'quick reader' note, no AI call, one log row with the units returned", async () => {
    const { agent } = await signIn(h, "broker");
    const page = await agent.get("/app/search").query({ q: "Mountain View 3 bedrooms" });
    expect(page.text).toContain("data-understood");
    expect(page.text).toMatch(/Quick reader|قراءة سريعة/);
    expect(page.text).toContain("data-report");
    expect(h.AI.calls.length).toBe(0);
    const [row] = await logs();
    expect(row.source).toBe("parser");
    expect(row.query_text).toBe("Mountain View 3 bedrooms");
    expect(row.local_filters.bedrooms_min).toBe(3);
    expect(row.ai_filters).toBeNull();
    expect(row.used_filters.bedrooms_min).toBe(3);
    expect(row.total).toBe(1);
    expect(row.result_ids).toHaveLength(1);
  });

  test("an unsure reading asks the AI; both readings are kept and the page says the AI read it", async () => {
    h.AI.respond((c) => (c.operation === "search_parse" ? AI_ANSWER : null));
    const { agent } = await signIn(h, "broker");
    const page = await agent.get("/app/search").query({ q: "شقة 5000" });
    expect(page.text).toMatch(/Read by the AI|قرأها الذكاء الاصطناعي/);
    expect(page.text).not.toContain("data-ask-ai"); // the AI already read it
    const [row] = await logs();
    expect(row.source).toBe("ai");
    expect(row.reasons).toContain("numbers_left");
    expect(row.local_filters).toBeTruthy();
    expect(row.ai_filters.bedrooms_min).toBe(3);
  });

  test("an exclusion is shown as not applied, not turned into a filter", async () => {
    const { agent } = await signIn(h, "broker");
    const page = await agent.get("/app/search").query({ q: "شقة بدون مصعد" });
    expect(page.text).toContain("data-unapplied");
    expect(page.text).toContain("بدون مصعد");
    const [row] = await logs();
    expect(row.unapplied).toEqual(["بدون مصعد"]);
    expect(row.used_filters.features).toEqual([]);
  });

  test("phone numbers in a search are not kept", async () => {
    const { agent } = await signIn(h, "broker");
    await agent.get("/app/search").query({ q: "شقة 3 غرف للعميل 01012345678" });
    const [row] = await logs();
    expect(row.query_text).not.toMatch(/0101234/);
  });

  test("the back/reload link shows the same block and writes no second log row", async () => {
    const { agent } = await signIn(h, "broker");
    const first = await agent.get("/app/search").query({ q: "Mountain View 3 bedrooms" });
    const url = first.text.match(/data-search-url="([^"]+)"/)[1].replace(/&amp;/g, "&");
    expect(url).toMatch(/&sl=/);
    const again = await agent.get(url);
    expect(again.text).toContain("data-understood");
    expect(await logs()).toHaveLength(1);
  });
});

describe("Wrong search? and Search again with AI", () => {
  test("the report keeps the search; sending it twice is harmless; another broker's search is not found", async () => {
    const { agent, csrf } = await signIn(h, "broker");
    await agent.get("/app/search").query({ q: "Mountain View 3 bedrooms" });
    const [row] = await logs();
    const send = () => agent.post("/app/search/report").set("X-CSRF-Token", csrf).type("form").send({ sl: row.id, note: "wrong compound" });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    const reports = await h.query("SELECT * FROM search_reports");
    expect(reports).toHaveLength(1);
    expect(reports[0].note).toBe("wrong compound");

    const other = await signIn(h, "colleague");
    const res = await other.agent.post("/app/search/report").set("X-CSRF-Token", other.csrf).type("form").send({ sl: row.id });
    expect(res.status).toBe(404);
  });

  test("'Search again with AI' calls the AI once, spends it only on request, and links the new log row to the first", async () => {
    h.AI.respond((c) => (c.operation === "search_parse" ? AI_ANSWER : null));
    const { agent } = await signIn(h, "broker");
    const first = await agent.get("/app/search").query({ q: "Mountain View 3 bedrooms" });
    expect(first.text).toContain("data-ask-ai");
    expect(h.AI.calls.length).toBe(0);
    const [row] = await logs();
    const href = first.text.match(/href="([^"]+)" data-ask-ai/)[1].replace(/&amp;/g, "&");
    const again = await agent.get(href);
    expect(again.text).toMatch(/Read by the AI|قرأها الذكاء الاصطناعي/);
    expect(h.AI.calls.length).toBe(1);
    const all = await logs();
    expect(all).toHaveLength(2);
    expect(all[1].rerun_of).toBe(row.id);
    expect(all[1].source).toBe("ai");
  });
});

describe("Telegram and WhatsApp buttons", () => {
  test("the report button saves a report; the AI button reads the search again with the AI", async () => {
    h.AI.respond((c) => (c.operation === "search_parse" ? AI_ANSWER : null));
    const reply = textOf(await h.text("broker", "Mountain View 3 bedrooms"));
    expect(reply).toMatch(/Quick reader|قراءة سريعة/);
    const [row] = await logs();
    const bad = textOf(await h.tap("broker", `sx:bad:${row.id}`));
    expect(bad).toMatch(/Reported|اتسجل/);
    expect(await h.query("SELECT 1 FROM search_reports")).toHaveLength(1);

    const again = textOf(await h.tap("broker", `sx:ai:${row.id}`));
    expect(again).toMatch(/Read by the AI|قرأها الذكاء الاصطناعي/);
    expect(h.AI.calls.length).toBe(1);
    expect((await logs()).find((r) => r.rerun_of === row.id)).toBeTruthy();
  });
});
