// tests/browser/qa-round4-layout.test.js — QA round 4 (#1, #4): the notification log does not overflow a phone width, and the icon-only
// buttons and links on home, units list and unit detail all have a name (text, aria-label or title). Needs Chromium and Playwright.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");

const PORT = 4579;
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

async function openAs(who, lang) {
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 } });
  const pg = await ctx.newPage();
  const br = h.BROKERS[who];
  await h.query("UPDATE brokers SET preferred_lang = $2 WHERE id = $1", [br.id, lang]);
  const token = await WebAuth.issueLoginToken(h.pool, { id: br.id, agency_id: br.agency_id });
  await pg.goto(`${BASE}/app/login/confirm?t=${token}`);
  await pg.click("form button[type=submit], form input[type=submit]");
  await pg.waitForLoadState("networkidle");
  return pg;
}

const overflow = (pg) => pg.evaluate(() => {
  const de = document.documentElement;
  const wide = [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > de.clientWidth + 1 && !e.closest(".scroll, .seg, .tabnav, .chipbar, [data-scroll]")).slice(0, 5).map((e) => `${e.tagName}.${e.className}`);
  return { sw: de.scrollWidth, cw: de.clientWidth, wide };
});
const unnamed = (pg) => pg.evaluate(() => [...document.querySelectorAll("a[href], button, [role=button]")]
  .filter((e) => e.getClientRects().length && !(e.textContent || "").trim() && !e.getAttribute("aria-label") && !e.getAttribute("title") && !e.getAttribute("aria-labelledby") && !(e.querySelector("img[alt]:not([alt=''])")))
  .map((e) => e.outerHTML.slice(0, 160)));

test("the notification log fits a 390px screen in English and Arabic", async () => {
  await h.seedBroker("manager");
  const Notifications = require("../../lib/notifications");
  const m = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.manager.id]))[0];
  for (let i = 0; i < 3; i++) await Notifications.notifyBroker(h.pool, m, { kind: "manager_alert", dedupeKey: `qa4:${i}`, title: `🧑‍💼 ${"Very long alert title with Samir_Abdelrahman_Mohamed_Hassan_Elsayed ".repeat(2)}${i}`, body: "x", url: "/app/leads" });
  for (const lang of ["en", "ar"]) {
    const pg = await openAs("manager", lang);
    await pg.goto(`${BASE}/app/notifications/log`);
    expect(await pg.locator("tr[data-log]").count()).toBeGreaterThan(0);
    const o = await overflow(pg);
    expect([lang, o.sw <= o.cw + 1, o.wide]).toEqual([lang, true, []]);
  }
});

test("icon-only buttons and links on home, units and a unit page have a name", async () => {
  await h.seedBroker("manager");
  const Leads = require("../../services/leads");
  const u = await h.insertListing({ broker_id: h.BROKERS.broker.id, code: "IC-1", property_type: "apartment", price_value: 3000000 });
  await h.insertListing({ broker_id: h.BROKERS.broker.id, code: "IC-2", property_type: "villa", price_value: 9000000, status: "sold" });
  for (let i = 0; i < 3; i++) await h.query("INSERT INTO listing_images (listing_id, agency_id, position, url) VALUES ($1, $2, $3, $4)", [u.id, h.AGENCY_A, i, `https://example.com/p${i}.jpg`]);
  const broker = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.broker.id]))[0];
  const lead = await Leads.captureLead(h.pool, broker, { phones: "01012345678", name: "Sara" });
  await Leads.setFollowUp(h.pool, broker, lead.lead?.id || lead.id, { at: new Date(Date.now() + 3600e3).toISOString(), kind: "call" }).catch(() => {});
  for (const who of ["broker", "manager"]) {
    for (const lang of ["en", "ar"]) {
      const pg = await openAs(who, lang);
      for (const path of ["/app/", "/app/units", "/app/units?status=sold", "/app/units/IC-1", "/app/leads"]) {
        await pg.goto(`${BASE}${path}`);
        expect([who, lang, path, await unnamed(pg)]).toEqual([who, lang, path, []]);
      }
    }
  }
});
