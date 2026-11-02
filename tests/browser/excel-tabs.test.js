// tests/browser/excel-tabs.test.js — The Excel import in a real browser: the workbook is read there (every tab), only cells are sent.
// Needs Chromium and Playwright. Run: npm run test:browser
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const fs = require("fs");
const os = require("os");
const path = require("path");
const ExcelJS = require("exceljs");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");

process.env.PUBLIC_BASE_URL = "http://127.0.0.1:4574";
jest.setTimeout(120000);

const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//;
let h, browser, server, dir;

async function makeWorkbook() {
  const wb = new ExcelJS.Workbook();
  const head = ["name", "number", "unit type", "location", "price", "details", "area", "descibation", "code"];
  for (const [tab, prefix] of [["Villette", "VR"], ["Mivida", "MI"]]) {
    const ws = wb.addWorksheet(tab);
    ws.addRow(head);
    for (let i = 1; i <= 3; i++) ws.addRow([`owner ${i}`, 1000000000 + i, "apartment", `building ${i}`, "25k", "3 bedrooms / 2 bathrooms", `${100 + i}m`, "fully finished", `${prefix}${i}`]);
  }
  const file = path.join(dir, "RENT - browser.xlsx");
  fs.writeFileSync(file, Buffer.from(await wb.xlsx.writeBuffer()));
  return file;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "excel-tabs-"));
  h = await createHarness();
  await h.seedBroker("manager");
  const { chromium } = require("playwright");
  browser = await chromium.launch({ args: ["--no-sandbox"] });
  server = h.app.app.listen(4574);
});

afterAll(async () => {
  if (browser) await browser.close();
  if (server) server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  await closeHarness();
});

test("a two-tab workbook is read in the browser and reviewed; the file itself never reaches the server", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, serviceWorkers: "block" });
  await ctx.route(/.*/, (route) => (LOCAL.test(route.request().url()) ? route.continue() : route.abort()));
  const pg = await ctx.newPage();
  pg.setDefaultTimeout(20000);
  const errors = [];
  pg.on("pageerror", (e) => errors.push(e.message));
  const uploads = [];
  pg.on("request", (r) => {
    if (r.method() === "POST" && /multipart/.test(r.headers()["content-type"] || "")) uploads.push(r.url());
  });
  const br = h.BROKERS.manager;
  const token = await WebAuth.issueLoginToken(h.pool, { id: br.id, agency_id: br.agency_id });
  await pg.goto(`http://127.0.0.1:4574/app/login/confirm?t=${token}`);
  await pg.click("form button[type=submit], form input[type=submit]");
  await pg.waitForURL((u) => !u.pathname.includes("login"));
  await pg.goto("http://127.0.0.1:4574/app/import", { waitUntil: "networkidle" });
  await pg.setInputFiles("form[data-xi] input[type=file]", await makeWorkbook());
  await pg.click("form[data-xi] button[type=submit]");
  await pg.waitForURL(/\/app\/import\/[0-9a-f-]{36}$/);
  const content = await pg.content();
  expect(content).toMatch(/Villette/);
  expect(content).toMatch(/Mivida/);
  expect((content.match(/data-row="/g) || []).length).toBeGreaterThanOrEqual(6);
  expect(uploads).toEqual([]);
  expect(errors).toEqual([]);
  await ctx.close();
});
