// tests/web/search-live.test.js — Search while typing (?live=1) reads the text with the local reader only: no AI call,
// no search log row. Enter (the full search) still uses the AI when the local reader is unsure.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  await h.insertListing({ broker_id: h.BROKERS.broker.id, code: "LV-1", property_type: "apartment", compound: "Hyde Park" });
});
afterAll(closeHarness);

test("a live search returns results with no AI call and no search log row", async () => {
  const b = await signIn(h, "broker");
  const before = h.AI.calls ? h.AI.calls.length : 0;
  const page = await b.agent.get("/app/search?q=apartment%20hyde%20park&live=1&lang=en");
  expect(page.status).toBe(200);
  expect(page.text).toMatch(/id="search-results"/);
  expect(page.text).toMatch(/LV-1/);
  expect(h.AI.calls ? h.AI.calls.length : 0).toBe(before);
  expect(await h.query("SELECT count(*)::int AS n FROM search_log")).toEqual([{ n: 0 }]);
});

test("the search box carries the live search and the visible Search button with a spinner", async () => {
  const b = await signIn(h, "broker");
  const page = (await b.agent.get("/app/search?lang=en")).text;
  expect(page).toMatch(/hx-get="\/app\/search"/);
  expect(page).toMatch(/hx-vals='\{"live":"1"\}'/);
  expect(page).toMatch(/class="search-go"[^>]*data-search-go/);
  expect(page).toMatch(/class="spin"/);
});
