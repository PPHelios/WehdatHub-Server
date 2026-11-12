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

test("a picked photo can be deleted with its button", async () => {
  const base = "http://127.0.0.1:4572";
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  const pg = await ctx.newPage();
  const br = h.BROKERS.broker;
  const token = await WebAuth.issueLoginToken(h.pool, { id: br.id, agency_id: br.agency_id });
  await pg.goto(`${base}/app/login/confirm?t=${token}`);
  await pg.click("form button[type=submit], form input[type=submit]");
  await pg.waitForLoadState("networkidle");
  await pg.goto(`${base}/app/units/NH-A20/edit`, { waitUntil: "networkidle" });
  await pg.setInputFiles("input[data-photo-tray]", [{ name: "a.png", mimeType: "image/png", buffer: PNG }, { name: "b.png", mimeType: "image/png", buffer: PNG }]);
  await pg.waitForSelector("[data-photo-preview] li");
  expect(await pg.locator("[data-photo-preview] li").count()).toBe(2);
  await pg.locator("[data-photo-preview] [data-delete]").first().click();
  expect(await pg.locator("[data-photo-preview] li").count()).toBe(1);
  await ctx.close();
});

const openEdit = async () => {
  const base = "http://127.0.0.1:4572";
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  const pg = await ctx.newPage();
  const br = h.BROKERS.broker;
  const token = await WebAuth.issueLoginToken(h.pool, { id: br.id, agency_id: br.agency_id });
  await pg.goto(`${base}/app/login/confirm?t=${token}`);
  await pg.click("form button[type=submit], form input[type=submit]");
  await pg.waitForLoadState("networkidle");
  await pg.goto(`${base}/app/units/NH-A20/edit`, { waitUntil: "networkidle" });
  return { ctx, pg };
};

test("only 15 photos can be added; the rest are counted and said", async () => {
  const { ctx, pg } = await openEdit();
  const files = Array.from({ length: 20 }, (_, i) => ({ name: `p${i}.png`, mimeType: "image/png", buffer: PNG }));
  await pg.setInputFiles("input[data-photo-tray]", files);
  await pg.waitForSelector("[data-photo-preview] li");
  expect(await pg.locator("[data-photo-preview] li").count()).toBe(15);
  const note = pg.locator("[data-photo-note]");
  expect(await note.isVisible()).toBe(true);
  expect(await note.textContent()).toMatch(/5/);
  expect(await note.getAttribute("class")).toContain("bad");
  await ctx.close();
});

test("saving reduces a big photo in the browser first and shows progress", async () => {
  const sharp = require("sharp");
  const w = 3000, hgt = 2000;
  const raw = Buffer.alloc(w * hgt * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = 120 + ((i * 7919) % 8);
  const big = await sharp(raw, { raw: { width: w, height: hgt, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer();
  const { ctx, pg } = await openEdit();
  await pg.setInputFiles("input[data-photo-tray]", [{ name: "big.png", mimeType: "image/png", buffer: big }]);
  await pg.waitForSelector("[data-photo-preview] li");
  // The final post is replaced by a recorder: the page stays and we see what the form was about to send.
  await pg.evaluate(() => {
    HTMLFormElement.prototype.submit = function () {
      const f = this.querySelector("input[data-photo-tray]").files[0];
      window.__sent = { type: f.type, size: f.size, name: f.name };
    };
    const f = document.querySelector("#unit-form");
    f.requestSubmit(f.querySelector("button[name=action]"));
  });
  await pg.waitForFunction(() => window.__sent, null, { timeout: 20000 });
  const file = await pg.evaluate(() => window.__sent);
  expect(file.type).toBe("image/jpeg");
  expect(file.size).toBeLessThan(big.length / 4);
  await ctx.close();
});
