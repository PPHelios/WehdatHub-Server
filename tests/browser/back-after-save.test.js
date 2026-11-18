// tests/browser/back-after-save.test.js — Back after a save goes to the page before the form, not to the used form
// (QA round 3, step 6; web/static/app.js). Browser Back and the page's ← Back link both. A form that came back with an
// error is not skipped. Needs Chromium and Playwright. Run: npm run test:browser
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");

const PORT = 4581;
const BASE = `http://127.0.0.1:${PORT}`;
process.env.PUBLIC_BASE_URL = BASE;
jest.setTimeout(180000);

let h, browser, server;
beforeAll(async () => {
  h = await createHarness();
  const { chromium } = require("playwright");
  browser = await chromium.launch({ args: ["--no-sandbox"] });
  server = h.app.app.listen(PORT);
});
afterAll(async () => {
  if (browser) await browser.close();
  if (server) server.close();
  await closeHarness();
});

async function openAs(who = "broker") {
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 } });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on("pageerror", (e) => errors.push(String(e.message || e)));
  const br = h.BROKERS[who];
  const token = await WebAuth.issueLoginToken(h.pool, { id: br.id, agency_id: br.agency_id });
  await pg.goto(`${BASE}/app/login/confirm?t=${token}`);
  await pg.click("form button[type=submit], form input[type=submit]");
  await pg.waitForLoadState("networkidle");
  return { ctx, pg, errors };
}

/** Opens the leads list, then the new-lead form from it, and saves a lead. Ends on the new lead's page. */
async function addLead(pg, phone) {
  await pg.goto(`${BASE}/app/leads?lang=en`, { waitUntil: "networkidle" });
  await pg.click('a[href="/app/leads/new"]');
  await pg.waitForURL(/\/app\/leads\/new/);
  await pg.fill('[name="name"]', "Back Test");
  await pg.fill('[name="phone1"]', phone);
  await pg.click('button[type=submit][data-tg-main]');
  await pg.waitForURL(/\/app\/leads\/L-\d+/, { timeout: 15000 });
  await pg.waitForLoadState("networkidle");
}

test("browser Back after saving a new lead returns to the leads list", async () => {
  const { ctx, pg, errors } = await openAs();
  await addLead(pg, "01011112233");
  expect(new URL(pg.url()).search).not.toContain("saved=1");
  await pg.goBack();
  await pg.waitForURL((u) => !/\/leads\/new/.test(u.pathname), { timeout: 5000 });
  await pg.waitForLoadState("networkidle");
  expect(new URL(pg.url()).pathname).toBe("/app/leads");
  expect(errors).toEqual([]);
  await ctx.close();
});

test("the page's ← Back link after saving also skips the used form", async () => {
  const { ctx, pg } = await openAs();
  await addLead(pg, "01011112244");
  await pg.click("a[data-back]");
  await pg.waitForURL((u) => !/\/leads\/(new|L-)/.test(u.pathname), { timeout: 5000 });
  expect(new URL(pg.url()).pathname).toBe("/app/leads");
  await ctx.close();
});

test("a form that came back with an error is not skipped", async () => {
  const { ctx, pg } = await openAs();
  await pg.goto(`${BASE}/app/leads?lang=en`, { waitUntil: "networkidle" });
  await pg.goto(`${BASE}/app/leads/new?lang=en`, { waitUntil: "networkidle" });
  await pg.fill('[name="phone1"]', "123");
  await pg.evaluate(() => { const f = document.querySelector('[name="phone1"]').form; f.noValidate = true; });
  await pg.click('button[type=submit][data-tg-main]');
  await pg.waitForLoadState("networkidle");
  // Still on the form (refused): it is not marked as used, so Back to it later shows it again.
  expect(new URL(pg.url()).pathname).toMatch(/\/app\/leads(\/new)?$/);
  await pg.goto(`${BASE}/app/units?lang=en`, { waitUntil: "networkidle" });
  const used = await pg.evaluate(() => JSON.parse(sessionStorage.getItem("wh-form-used") || "{}"));
  expect(used["/app/leads/new"]).toBeUndefined();
  // Back to the refused form shows it again, without "Confirm form resubmission" (finding 77).
  await pg.goBack();
  await pg.waitForLoadState("networkidle");
  await pg.waitForTimeout(600);
  expect(new URL(pg.url()).pathname).toMatch(/\/app\/leads(\/new)?$/);
  expect(await pg.locator('[name="phone1"]').count()).toBe(1);
  await ctx.close();
});

test("an error sent back on a long page is shown where the person is: toast and scrolled into view", async () => {
  const { ctx, pg } = await openAs();
  await pg.goto(`${BASE}/app/leads/new?lang=en`, { waitUntil: "networkidle" });
  await pg.fill('[name="name"]', "Error Test");
  await pg.fill('[name="phone1"]', "123");
  await pg.evaluate(() => { const f = document.querySelector('[name="phone1"]').form; f.noValidate = true; window.scrollTo(0, document.body.scrollHeight); });
  await pg.click('button[type=submit][data-tg-main]');
  await pg.waitForLoadState("networkidle");
  const seen = await pg.evaluate(() => {
    const n = document.querySelector("#main .notice.bad:not([hidden])");
    const t = document.querySelector("[data-toast-box]");
    if (!n) return { notice: false };
    const r = n.getBoundingClientRect();
    return { notice: true, inView: r.bottom > 0 && r.top < window.innerHeight, toast: Boolean(t && !t.hidden && t.textContent.trim()) };
  });
  expect(seen).toEqual({ notice: true, inView: true, toast: true });
  await ctx.close();
});
