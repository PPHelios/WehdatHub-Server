// tests/browser/unit-photo-pick.test.js — The edit form's photo picker: the first pick must show in the list.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");

process.env.PUBLIC_BASE_URL = "http://127.0.0.1:4572";
jest.setTimeout(120000);

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
let h, browser, server;

beforeAll(async () => {
  h = await createHarness();
  const { chromium } = require("playwright");
  browser = await chromium.launch({ args: ["--no-sandbox"] });
  await h.insertListing({ code: "NH-A20", title: "NH-A20 unit", compound: "Hyde Park", price_value: 4e6, area_value: 90, bedrooms: 2 });
  server = h.app.app.listen(4572);
});

afterAll(async () => {
  if (browser) await browser.close();
  if (server) server.close();
  await closeHarness();
});

test("the first photo pick on the edit form shows in the list", async () => {
  const base = "http://127.0.0.1:4572";
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  const pg = await ctx.newPage();
  const br = h.BROKERS.broker;
  const token = await WebAuth.issueLoginToken(h.pool, { id: br.id, agency_id: br.agency_id });
  await pg.goto(`${base}/app/login/confirm?t=${token}`);
  await pg.click("form button[type=submit], form input[type=submit]");
  await pg.waitForLoadState("networkidle");
  await pg.goto(`${base}/app/units/NH-A20/edit`, { waitUntil: "networkidle" });
  await pg.setInputFiles("input[data-photo-tray]", [{ name: "a.png", mimeType: "image/png", buffer: PNG }]);
  await pg.waitForSelector("[data-photo-preview] li", { timeout: 5000 });
  expect(await pg.locator("[data-photo-preview] li").count()).toBe(1);
  await ctx.close();
});
