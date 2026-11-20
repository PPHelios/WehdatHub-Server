// tests/web/search-bar.test.js — home and search share one search bar: one round button (mic when empty, send when
// typed, switched by web/static/app.js), no text "Search" button, the same voice endpoint on both.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");

jest.setTimeout(60000);

let h;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

test.each([["/app/", "home"], ["/app/search", "search page"], ["/app/search?lang=en", "search page (en)"]])("%s has the one round button and no text Search button", async (path) => {
  const { agent } = await signIn(h, "broker");
  const page = await agent.get(path);
  expect(page.status).toBe(200);
  expect(page.text).toMatch(/<button type="button" class="mic sb-act"[^>]*data-mic[^>]*data-voice-url="\/app\/search\/voice"/);
  expect(page.text).toContain('class="searchbox sb');
  expect(page.text).not.toContain("search-go\">");
  expect(page.text).not.toContain("?voice=1");
  expect((page.text.match(/data-mic/g) || []).length).toBe(1);
});

test("a typed query shows the search label and the send state", async () => {
  const { agent } = await signIn(h, "broker");
  const page = await agent.get("/app/search?q=%D8%B4%D9%82%D8%A9");
  expect(page.text).toContain("searchbox sb float has-text");
});
