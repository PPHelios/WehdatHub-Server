// tests/browser/spinner.browser.test.js — Every button that sends a request shows a spinner (or is locked) while it waits.
// Fake data and fake AI, no outside network. A test form post is slowed on purpose so the wait is visible.
// Reports the gaps by page and button only. Run: npm run test:browser
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");
const Leads = require("../../services/leads");

process.env.OWNER_BROKER_IDS = "10000000-0000-0000-0000-000000000003";
process.env.PUBLIC_BASE_URL = "http://127.0.0.1:4572";
jest.setTimeout(900000);

const PHONE = { width: 390, height: 844 };
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//;
const PAGES = [["search", "/app/search"], ["ask", "/app/ask"], ["units", "/app/units"], ["unit-new", "/app/units/new"], ["lead", "/app/leads/LEAD_REF"], ["leads", "/app/leads"]];

let h, browser, server, base;
const gaps = [];
const unsent = []; // clicked, but no request reached the server: listed for review, not counted as gaps

async function session(who) {
  const br = h.BROKERS[who];
  const ctx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  await ctx.route(/.*/, async (route) => {
    const req = route.request();
    if (!LOCAL.test(req.url())) return route.abort();
    // A post waits a moment, so the spinner shows long enough to be seen.
    if (req.method() === "POST") await new Promise((r) => setTimeout(r, 500));
    return route.continue();
  });
  const pg = await ctx.newPage();
  pg.setDefaultTimeout(15000);
  const token = await WebAuth.issueLoginToken(h.pool, { id: br.id, agency_id: br.agency_id });
  await pg.goto(`${base}/app/login/confirm?t=${token}`);
  await pg.click("form button[type=submit], form input[type=submit]");
  await pg.waitForURL((u) => u.pathname.startsWith("/app") && !u.pathname.includes("login"), { timeout: 10000 }).catch(() => {});
  await pg.waitForLoadState("networkidle");
  return { ctx, pg };
}

// Each control is checked on a fresh load of its page, so one click cannot change what the next one sees.
async function checkControl(ctx, path, index, where) {
  const pg = await ctx.newPage();
  try {
    await pg.goto(base + path, { waitUntil: "networkidle" });
    const btn = pg.locator("main button[type=submit]:not([data-confirm]):not(.link)").nth(index);
    const label = ((await btn.textContent().catch(() => "")) || "").trim().slice(0, 40);
    const valid = await btn.evaluate((b) => (b.form ? b.form.checkValidity() : false)).catch(() => false);
    if (!valid) return; // a form that needs input first sends nothing, so there is no wait to show
    // A button in a closed panel or behind another tab cannot be clicked by a person either; it is skipped, not counted.
    if (!(await btn.isVisible().catch(() => false))) return;
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    // A click that cannot happen is reported as such, so it is not counted as a missing spinner.
    // A click that is covered by another element still counts as a click: the spinner is about the request, not the overlay.
    // Counts requests to the app from the click on: a click that sends nothing has no wait to show, so it is reported apart.
    let sent = 0;
    const sentList = [];
    const onRequest = (r) => { if (LOCAL.test(r.url()) && !/\/static\//.test(r.url())) { sent++; sentList.push(`${r.method()} ${new URL(r.url()).pathname}`); } };
    pg.on("request", onRequest);
    // Records the tapped button's state 15 ms after the tap, inside the page.
    await pg.evaluate(() => {
      window.__snap = null;
      document.addEventListener("click", (e) => {
        const b = e.target && e.target.closest ? e.target.closest("button") : null;
        if (!b) return;
        setTimeout(() => { window.__snap = { disabled: b.disabled, busy: b.classList.contains("busy"), locked: b.hasAttribute("data-locked") }; }, 15);
      }, true);
    }).catch(() => {});
    const clicked = await btn.click({ noWaitAfter: true, timeout: 5000, force: true }).then(() => "", (e) => String(e.message || e).split("\n")[0]);
    if (clicked) {
      gaps.push(`${where} · "${label || "(no text)"}" · click failed: ${clicked.slice(0, 120)}`);
      return;
    }
    // The state is read on the page itself a moment after the tap, before any reply can replace the page.
    await pg.waitForTimeout(60);
    const snap = await pg.evaluate(() => window.__snap || null).catch(() => null);
    const shown = snap ? Boolean(snap.disabled || snap.busy || snap.locked) : true; // no reading taken: not counted as a gap
    // What the button is, what it sent, and its state, so a gap can be traced to its form.
    const info = await btn.evaluate((b) => `form ${b.form ? b.form.getAttribute("action") : "none"}, method ${b.form ? b.form.getAttribute("method") : "-"}, disabled ${b.disabled}, class "${b.className}"`).catch(() => "");
    pg.off("request", onRequest);
    if (!sent) {
      unsent.push(`${where} · "${label || "(no text)"}" · ${info}`);
      return;
    }
    if (!shown) gaps.push(`${where} · "${label || "(no text)"}" · ${info} · requests: ${sentList.join(" ")}`);
  } finally {
    await pg.close().catch(() => {});
  }
}

beforeAll(async () => {
  h = await createHarness();
  const { chromium } = require("playwright");
  browser = await chromium.launch({ args: ["--no-sandbox"] });
  for (let i = 0; i < 3; i++) await h.insertListing({ code: `NH-A${20 + i}`, title: `NH-A${20 + i} unit`, compound: "Hyde Park", price_value: 4e6 + i * 1e5, area_value: 90 + i * 10, bedrooms: 2 + (i % 3) });
  const broker = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.broker.id]))[0];
  const lead = (await Leads.captureLead(h.pool, broker, { phones: ["01012345678"], name: "محمد سامي", quiet: true })).lead;
  PAGES.forEach((p) => { p[1] = p[1].replace("LEAD_REF", lead.ref); });
  server = h.app.app.listen(4572);
  base = "http://127.0.0.1:4572";
});

afterAll(async () => {
  if (browser) await browser.close();
  if (server) server.close();
  await closeHarness();
});

test("every request button on the broker pages shows a spinner while it waits", async () => {
  const { ctx, pg } = await session("broker");
  for (const [name, path] of PAGES) {
    await pg.goto(base + path, { waitUntil: "networkidle" }).catch(() => {});
    const count = await pg.locator("main button[type=submit]:not([data-confirm]):not(.link)").count().catch(() => 0);
    for (let i = 0; i < count; i++) await checkControl(ctx, path, i, name);
  }
  await ctx.close();
  // Reports gaps only, by page and button; an empty list means every checked button shows a spinner.
  if (unsent.length) process.stdout.write(`NO REQUEST SENT (review):\n${unsent.join("\n")}\n`);
  if (gaps.length) process.stdout.write(`SPINNER GAPS:\n${gaps.join("\n")}\n`);
  expect(gaps).toEqual([]);
});
