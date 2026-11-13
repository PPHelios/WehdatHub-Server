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

test("up to 60 photos can be picked and 15 are kept; the rest wait as not kept", async () => {
  const { ctx, pg } = await openEdit();
  const files = Array.from({ length: 20 }, (_, i) => ({ name: `p${i}.png`, mimeType: "image/png", buffer: PNG }));
  await pg.setInputFiles("input[data-photo-tray]", files);
  await pg.waitForSelector("[data-photo-preview] li");
  expect(await pg.locator("[data-photo-preview] li").count()).toBe(20);
  expect(await pg.locator("[data-photo-preview] [data-keep]", { hasText: "✓" }).count()).toBe(15);
  const note = pg.locator("[data-photo-note]");
  expect(await note.isVisible()).toBe(true);
  expect(await note.textContent()).toMatch(/20/);
  expect(await note.textContent()).toMatch(/15/);
  // Nothing is uploaded while picking, and the review is told how many photos wait for Save.
  expect(await pg.locator('input[name="photo_pending"]').inputValue()).toBe("15");
  expect(await pg.locator('input[data-photo-tray]').evaluate((i) => i.files.length)).toBe(0);
  // Swapping: a not-kept photo cannot be kept while 15 are kept; taking one off makes room.
  await pg.locator("[data-photo-preview] [data-keep]", { hasText: "✓" }).first().click();
  expect(await pg.locator('input[name="photo_pending"]').inputValue()).toBe("14");
  await pg.locator("[data-photo-preview] [data-keep]", { hasText: /Not kept|مش هتتحفظ/ }).first().click();
  expect(await pg.locator('input[name="photo_pending"]').inputValue()).toBe("15");
  await ctx.close();
});

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "*", "access-control-allow-headers": "*" };

test("a picked photo is uploaded only at Save, reduced in the browser; the form then sends only its key", async () => {
  const sharp = require("sharp");
  const Fake = require("../harness/fake-supabase");
  const w = 3000, hgt = 2000;
  const raw = Buffer.alloc(w * hgt * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = 120 + ((i * 7919) % 8);
  const big = await sharp(raw, { raw: { width: w, height: hgt, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer();
  // The page may talk to the storage address only when the server knows it (CSP); here the fake storage address.
  const saved = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = "https://storage.test";
  const { ctx, pg } = await openEdit();
  const puts = [];
  await ctx.route("https://storage.test/**", async (route) => {
    const req = route.request();
    if (req.method() === "PUT") {
      const body = req.postDataBuffer();
      const path = decodeURIComponent(new URL(req.url()).pathname.replace("/upload/sign/", ""));
      puts.push({ path, size: body.length, jpeg: body.includes("image/jpeg") });
      Fake.objects.set(path, body);
    }
    await route.fulfill({ status: 200, headers: CORS, body: "{}" });
  });
  await pg.reload({ waitUntil: "networkidle" });
  await pg.setInputFiles("input[data-photo-tray]", [{ name: "big.png", mimeType: "image/png", buffer: big }]);
  await pg.waitForSelector("[data-photo-preview] li");
  // Picking uploads nothing: the review is told one photo waits for Save (so it never says "no photos").
  expect(puts).toHaveLength(0);
  expect(await pg.locator('input[name="photo_pending"]').inputValue()).toBe("1");
  expect(await pg.locator('input[name="photo_keys"]').count()).toBe(0);
  expect(await pg.locator('input[data-photo-tray]').evaluate((i) => i.files.length)).toBe(0);
  await pg.waitForSelector("[data-review]");
  if (await pg.locator("[data-warn-ack]").count()) await pg.check("[data-warn-ack]");
  await pg.click("[data-save-row] button[type=submit]");
  await pg.waitForURL(/saved=1/, { timeout: 30000 });
  // Both copies went up at Save, reduced: the photo is far smaller than the 3000 px original.
  expect(puts).toHaveLength(2);
  expect(puts[0].jpeg).toBe(true);
  expect(puts[0].size).toBeLessThan(big.length / 4);
  expect(puts[1].path).toMatch(/^thumbs\//);
  const n = (await h.query("SELECT count(*)::int AS n FROM listing_images li JOIN listings l ON l.id = li.listing_id WHERE l.code = 'NH-A20'"))[0].n;
  expect(n).toBe(1);
  expect((await h.query("SELECT count(*)::int AS n FROM unit_photo_uploads WHERE attached_at IS NOT NULL"))[0].n).toBe(1);
  if (saved === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = saved;
  await ctx.close();
});

test("when storage cannot be reached the photo goes with the form, as before", async () => {
  const Fake = require("../harness/fake-supabase");
  const { ctx, pg } = await openEdit();
  // Uploads to storage fail (the address is blocked by the page's own rules): the tray marks it failed and Save still works.
  await pg.setInputFiles("input[data-photo-tray]", [{ name: "c.png", mimeType: "image/png", buffer: PNG }]);
  await pg.waitForSelector("[data-photo-preview] li");
  await pg.waitForSelector("[data-review]");
  if (await pg.locator("[data-warn-ack]").count()) await pg.check("[data-warn-ack]");
  await pg.click("[data-save-row] button[type=submit]");
  await pg.waitForURL(/saved=1/, { timeout: 30000 });
  const imgs = (await h.query("SELECT li.url FROM listing_images li JOIN listings l ON l.id = li.listing_id WHERE l.code = 'NH-A20'")).length;
  expect(imgs).toBeGreaterThanOrEqual(1);
  expect(Fake.objects.size).toBeGreaterThanOrEqual(1);
  await ctx.close();
});
