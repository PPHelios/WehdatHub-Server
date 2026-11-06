// tests/web/upload-progress.test.js — Excel, group-post zip and price-sheet uploads, and the unit form, send with a progress bar
// (the form carries data-progress; the page script handles the upload).
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

test("the Excel import page's upload form has a progress bar", async () => {
  await h.seedBroker("manager");
  const { agent } = await signIn(h, "manager");
  const page = (await agent.get("/app/import?lang=en")).text;
  expect(page).toMatch(/action="\/app\/import\/excel"[^>]*data-progress/);
  expect(page).toMatch(/action="\/app\/import\/group"[^>]*data-progress/);
});

test("the lead import and the unit form send with progress", async () => {
  await h.seedBroker("owner");
  const { agent } = await signIn(h, "owner");
  expect((await agent.get("/app/leads/import?lang=en")).text).toMatch(/action="\/app\/leads\/import"[^>]*data-progress/);
  expect((await agent.get("/app/units/new?lang=en")).text).toMatch(/id="unit-form"[^>]*data-progress/);
});
