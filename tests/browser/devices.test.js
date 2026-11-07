// tests/browser/devices.test.js — Every screen on phone, tablet and desktop sizes (patch 6, and the per-screen checks deferred from patch 3):
// each signed-in page without an id opens, throws no script error, and does not scroll sideways. Screenshots go to test-results/screens.
// Needs Chromium and Playwright. Run: npm run test:browser
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const fs = require("fs");
const path = require("path");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");

process.env.PUBLIC_BASE_URL = "http://127.0.0.1:4575";
jest.setTimeout(600000);

const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//;
const DEVICES = ["iPhone SE", "Pixel 5", "iPad Mini", "Desktop Chrome"];
const OUT = path.join(__dirname, "../../test-results/screens");
let h, browser, server;

/** Every GET page path in web/routes that has no id in it (public share pages, static assets, sign-in and sign-out are left out). */
function pagePaths() {
  const dir = path.join(__dirname, "../../web/routes");
  const out = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    for (const m of fs.readFileSync(path.join(dir, f), "utf8").matchAll(/web\.get\(\s*"([^"]+)"/g)) out.add(m[1]);
  }
  return [...out].filter((p) => !p.includes(":") && !p.includes("*") && !p.startsWith("/v/") && !/^\/(login|logout|static|sw)/.test(p) && !/\.(js|json|webmanifest|css|png|pdf|xlsx|csv)$/.test(p)).sort();
}

beforeAll(async () => {
  h = await createHarness();
  await h.seedBroker("owner");
  await h.insertListing({ code: "DEV-1", compound: "Device Compound" });
  const { chromium } = require("playwright");
  browser = await chromium.launch({ args: ["--no-sandbox"] });
  server = h.app.app.listen(4575);
});

afterAll(async () => {
  if (browser) await browser.close();
  if (server) server.close();
  await closeHarness();
});

test("every screen opens without script errors or sideways scrolling on each device", async () => {
  const { devices } = require("playwright");
  const paths = pagePaths();
  expect(paths.length).toBeGreaterThan(20);
  const problems = [];
  for (const name of DEVICES) {
    const ctx = await browser.newContext({ ...devices[name], serviceWorkers: "block" });
    await ctx.route(/.*/, (route) => (LOCAL.test(route.request().url()) ? route.continue() : route.abort()));
    const pg = await ctx.newPage();
    pg.setDefaultTimeout(20000);
    let errors = [];
    pg.on("pageerror", (e) => errors.push(e.message));
    const br = h.BROKERS.owner;
    const token = await WebAuth.issueLoginToken(h.pool, { id: br.id, agency_id: br.agency_id });
    await pg.goto(`http://127.0.0.1:4575/app/login/confirm?t=${token}`);
    await pg.click("form button[type=submit], form input[type=submit]");
    await pg.waitForURL((u) => !u.pathname.includes("login"));
    fs.mkdirSync(path.join(OUT, name.replace(/\W+/g, "-")), { recursive: true });
    for (const p of paths) {
      errors = [];
      const res = await pg.goto(`http://127.0.0.1:4575/app${p}`, { waitUntil: "domcontentloaded" }).catch((e) => ({ status: () => `nav ${e.message.slice(0, 60)}` }));
      const status = res.status();
      if (typeof status !== "number" || status >= 500) problems.push(`${name} ${p}: status ${status}`);
      const over = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth).catch(() => 0);
      if (over > 2) problems.push(`${name} ${p}: scrolls sideways by ${over}px`);
      if (errors.length) problems.push(`${name} ${p}: script error ${errors[0].slice(0, 80)}`);
      await pg.screenshot({ path: path.join(OUT, name.replace(/\W+/g, "-"), `${p.replace(/\W+/g, "_") || "home"}.png`) }).catch(() => {});
    }
    await ctx.close();
  }
  expect(problems).toEqual([]);
});
