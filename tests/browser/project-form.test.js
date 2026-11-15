// tests/browser/project-form.test.js — The developer catalogue in a real browser: the add-project form (paste a launch message → name, developer, place and
// numbers fill in; the developer list; saving) and the search box (a place chip, a feature chip).
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");
const Catalogue = require("../../services/catalogue");
const Suggest = require("../../services/placeSuggest");
const Paste = require("../fixtures/project-pastes");

process.env.PUBLIC_BASE_URL = "http://127.0.0.1:4582";
jest.setTimeout(120000);

const BASE = "http://127.0.0.1:4582";
let h, browser, server, admin, obour;

beforeAll(async () => {
  h = await createHarness();
  await h.query("INSERT INTO areas (name_key, name_en, name_ar, aliases) VALUES ('new obour city', 'New Obour City', 'العبور الجديدة', ARRAY['New Obour']) ON CONFLICT DO NOTHING");
  obour = (await h.query("SELECT id FROM areas WHERE name_en = 'New Obour City'"))[0].id;
  Suggest.resetCache();
  admin = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];
  await Catalogue.saveDeveloper(h.pool, admin, { name: "Palm Hills" });
  await Catalogue.saveProject(h.pool, admin, { name: "Alpha Obour", area_id: obour, feature: ["roof"], price_from: "3,000,000", paste_text: "" });
  await Catalogue.saveProject(h.pool, admin, { name: "Beta Elsewhere", paste_text: "" });
  const { chromium } = require("playwright");
  browser = await chromium.launch({ args: ["--no-sandbox"] });
  server = h.app.app.listen(4582);
});

afterAll(async () => {
  if (browser) await browser.close();
  if (server) server.close();
  await closeHarness();
});

async function open(path) {
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  const pg = await ctx.newPage();
  const token = await WebAuth.issueLoginToken(h.pool, { id: admin.id, agency_id: admin.agency_id });
  await pg.goto(`${BASE}/app/login/confirm?t=${token}`);
  await pg.click("form button[type=submit], form input[type=submit]");
  await pg.waitForLoadState("networkidle");
  await pg.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  return { ctx, pg };
}

test("pasting a launch message fills the name, developer, place and numbers; the broker checks and adds the project", async () => {
  const { ctx, pg } = await open("/app/catalogue/projects/new?lang=en");
  await pg.fill("[data-project-source]", Paste.ARABISK);
  await pg.click("[data-project-read]");
  await pg.waitForFunction(() => document.querySelector("[data-project-found]").textContent.length > 0);
  expect(await pg.inputValue('input[name="name"]')).toBe("THE NEW BALANCE");
  expect(await pg.inputValue("[data-dev-input]")).toBe("ARABISK DEVELOPMENT");
  expect(await pg.locator('[data-ubox-chip="place"]').innerText()).toMatch(/New Obour/);
  expect(await pg.inputValue('input[name="price_from"]')).toBe("2000000");
  expect(await pg.inputValue('input[name="area_acres"]')).toBe("15");
  expect(await pg.locator('input[name="bedrooms"][value="3"]').isChecked()).toBe(true);
  expect(await pg.inputValue('select[name="status"]')).toBe("launching");
  // The steps: Next walks them, the last one has the save button.
  await pg.getByRole("button", { name: "Next" }).click();
  await pg.getByRole("button", { name: "Next" }).click();
  await pg.click("[data-project-save]");
  await pg.waitForURL(/\/app\/catalogue\/projects\/[0-9a-f-]{36}/);
  const p = (await h.query("SELECT * FROM projects WHERE name = 'THE NEW BALANCE'"))[0];
  expect(p).toMatchObject({ developer_name: "ARABISK DEVELOPMENT", area_id: obour });
  await ctx.close();
});

test("the developer box lists the agency's developers and keeps a new name", async () => {
  const { ctx, pg } = await open("/app/catalogue/projects/new?lang=en");
  const again = { ctx, pg };
  await again.pg.evaluate(() => { document.querySelectorAll("[data-step]").forEach((s) => { s.hidden = false; }); });
  await again.pg.fill("[data-dev-input]", "palm");
  await again.pg.locator("[data-dev-list] button", { hasText: "Palm Hills" }).first().click();
  expect(await again.pg.inputValue('input[name="developer_id"]', { timeout: 2000 }).catch(() => "")).not.toBe("");
  await again.pg.fill("[data-dev-input]", "Brand New Dev");
  expect(await again.pg.inputValue('input[name="developer_name"]')).toBe("Brand New Dev");
  expect(await again.pg.inputValue('input[name="developer_id"]')).toBe("");
  await again.ctx.close();
});

test("the search box: typing a place suggests it, picking it filters the cards and shows a chip that removes it", async () => {
  const { ctx, pg } = await open("/app/catalogue?lang=en");
  expect(await pg.locator(".pj-card").count()).toBeGreaterThanOrEqual(2);
  await pg.fill("[data-csearch-input]", "obour");
  await pg.locator("[data-csearch-list] [data-i]", { hasText: /New Obour/ }).first().click();
  await pg.waitForURL(/pl=/);
  expect(await pg.locator(".pj-card").allInnerTexts().then((t) => t.join(" "))).not.toContain("Beta Elsewhere");
  expect(await pg.locator(".csearch .chip-place").count()).toBe(1);
  await pg.click(".csearch .chip-place");
  await pg.waitForLoadState("networkidle");
  expect(await pg.locator(".pj-card").count()).toBeGreaterThanOrEqual(2);
  await ctx.close();
});
