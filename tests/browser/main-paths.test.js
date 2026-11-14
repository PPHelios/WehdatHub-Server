// tests/browser/main-paths.test.js — The main paths that must never break, in a real phone-sized browser, read back from the
// database: add a unit through every step, add a look-alike unit (the duplicate warning accepted at Next never blocks Save),
// a save whose answer is lost on the way back, a save the server never got (Try again saves once), edit a unit, and search
// finds the unit. Each failure says which step stopped and what the page showed. Fake data, fake AI, no outside network.
// Needs Chromium and Playwright. Run: npm run test:browser
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");

const PORT = 4576;
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

const unit = async (code) => (await h.query("SELECT * FROM listings WHERE code = $1", [code]))[0];
const countLike = async (prefix) => (await h.query("SELECT count(*)::int AS n FROM listings WHERE code LIKE $1", [`${prefix}%`]))[0].n;

/** A signed-in broker on a phone-sized page; script errors are collected so a test can fail on them. */
async function openAs(who = "broker") {
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 } });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on("pageerror", (e) => { errors.push(String(e.message || e)); CONSOLE.push(`pageerror ${e.message || e}`); });
  pg.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") CONSOLE.push(`${m.type()} ${m.text().slice(0, 200)}`); });
  pg.on("requestfinished", async (r) => { if (/step-check/.test(r.url())) CHECKS.push(`${(await r.response())?.status()} ${(await (await r.response())?.text().catch(() => "")) ?.slice(0, 200)}`); });
  pg.on("requestfailed", (r) => { if (/step-check/.test(r.url())) CHECKS.push(`failed ${r.failure()?.errorText}`); });
  const br = h.BROKERS[who];
  const token = await WebAuth.issueLoginToken(h.pool, { id: br.id, agency_id: br.agency_id });
  await pg.goto(`${BASE}/app/login/confirm?t=${token}`);
  await pg.click("form button[type=submit], form input[type=submit]");
  await pg.waitForLoadState("networkidle");
  return { ctx, pg, errors };
}

/** What the page says right now (step error, refusal banner, save status, fields the browser refuses, a busy Next, the last
 * step checks and their answers), for failure messages. */
const pageSays = (pg) => pg.evaluate(() => {
  const out = [...document.querySelectorAll("#unit-form .notice.bad, [data-step-error], [data-save-status], .step-err")]
    .filter((n) => !n.hidden && n.textContent.trim()).map((n) => n.textContent.trim());
  const parts = [...document.querySelectorAll("#unit-form [data-step]")].filter((n) => !n.hidden);
  for (const f of parts.flatMap((p) => [...p.querySelectorAll("input, select, textarea")])) {
    if (f.willValidate && !f.checkValidity()) out.push(`invalid ${f.name}="${f.value}": ${f.validationMessage}`);
  }
  const nx = [...document.querySelectorAll("#unit-form button[type=button]")].find((b) => /^(Next|التالي)$/.test(b.textContent.trim()));
  if (nx && (nx.disabled || nx.classList.contains("is-busy"))) out.push("Next is busy (waiting for the step check)");
  return out.join(" | ");
}).then((t) => `${t}${CHECKS.length ? ` | step checks: ${CHECKS.slice(-3).join(", ")}` : " | no step check sent"}${CONSOLE.length ? ` | console: ${CONSOLE.slice(-5).join(" / ")}` : ""}`);
const CHECKS = [];
const CONSOLE = [];

const visibleStep = (pg) => pg.evaluate(() => {
  const s = [...document.querySelectorAll("#unit-form [data-step]")].find((n) => !n.hidden);
  return s ? Number(s.getAttribute("data-step")) : 0;
});

/** Taps Next and waits for the next step; fails with what the page showed if the step does not move. */
async function next(pg, label) {
  const from = await visibleStep(pg);
  await pg.locator("#unit-form button[type=button]", { hasText: /^(Next|التالي)$/ }).first().click();
  try {
    await pg.waitForFunction((f) => {
      const s = [...document.querySelectorAll("#unit-form [data-step]")].find((n) => !n.hidden);
      return s && Number(s.getAttribute("data-step")) > f;
    }, from, { timeout: 15000 });
  } catch {
    throw new Error(`${label}: Next did not move past step ${from}. Page says: ${await pageSays(pg)}`);
  }
}

/** Fills step 1 to step 3 of the add form with a complete unit. */
async function fillUnit(pg, { code, price = "9 مليون", area = "150", phone = "01012345678" }) {
  await pg.goto(`${BASE}/app/units/new?lang=en`, { waitUntil: "networkidle" });
  await pg.fill('#unit-form [name="code"]', code);
  await pg.selectOption('#unit-form [name="listing_type"]', "sale");
  await pg.selectOption('#unit-form [name="property_type"]', "apartment");
  await pg.fill('#unit-form [name="compound"]', "Hyde Park");
  await pg.fill('#unit-form [name="price_value"]', price);
  await pg.fill('#unit-form [name="area_value"]', area);
  await pg.fill('#unit-form [name="bedrooms"]', "3");
  await pg.fill('#unit-form [name="bathrooms"]', "2");
  await pg.selectOption('#unit-form [name="finishing"]', "fully_finished");
  return { phone };
}

/** Goes from step 1 to the last step (check and save), filling the owner on the way. */
async function toSave(pg, { phone }, label, { from = 1 } = {}) {
  if (from <= 1) await next(pg, `${label} step 1`);
  await next(pg, `${label} step 2`);
  await pg.fill('#unit-form [name="owner_name"]', "Mr Owner");
  await pg.fill('#unit-form [name="owner_phone"]', phone);
  await next(pg, `${label} step 3`);
  await pg.waitForSelector("#unit-form [data-review]", { timeout: 15000 });
  await pg.waitForFunction(() => {
    const b = document.querySelector("#unit-form [data-save-row] button[type=submit]");
    const ack = document.querySelector("#unit-form [data-warn-ack]");
    return b && (!b.disabled || (ack && !ack.checked));
  }, null, { timeout: 15000 });
  if (await pg.locator("#unit-form [data-warn-ack]").count()) await pg.check("#unit-form [data-warn-ack]");
}

/** Taps Save and waits for the unit page; fails with what the page showed if it never gets there. */
async function save(pg, label, timeout = 30000) {
  await pg.click("#unit-form [data-save-row] button[type=submit]");
  try {
    await pg.waitForURL(/\/app\/units\/[^/?]+\?saved=1/, { timeout });
  } catch {
    throw new Error(`${label}: Save did not open the saved unit. Page says: ${await pageSays(pg)}`);
  }
  return decodeURIComponent(pg.url().match(/units\/([^?]+)/)[1]);
}

test("add a unit through every step: it is saved with what was typed", async () => {
  const { ctx, pg, errors } = await openAs();
  const opts = await fillUnit(pg, { code: "MP-ADD1", phone: "01011110001" });
  await toSave(pg, opts, "add");
  const code = await save(pg, "add");
  expect(code).toBe("MP-ADD1");
  const u = await unit("MP-ADD1");
  expect(u).toBeTruthy();
  expect(Number(u.price_value)).toBe(9e6);
  expect(Number(u.area_value)).toBe(150);
  expect(u.bedrooms).toBe(3);
  expect(u.agency_id).toBe(h.BROKERS.broker.agency_id);
  expect(errors).toEqual([]);
  await ctx.close();
});

test("a look-alike unit: the warning shows at Next, Next again accepts it, and Save is never blocked by it", async () => {
  await h.insertListing({ code: "MP-DUP0", title: "MP-DUP0", compound: "Hyde Park", price_value: 7e6, area_value: 133, bedrooms: 3, bathrooms: 2 });
  const { ctx, pg, errors } = await openAs();
  // Same compound, type, rooms, size and price as MP-DUP0: the server calls it a look-alike.
  const opts = await fillUnit(pg, { code: "MP-DUP1", price: "7 مليون", area: "133", phone: "01022220001" });
  await pg.locator("#unit-form button[type=button]", { hasText: /^(Next|التالي)$/ }).first().click();
  await pg.waitForFunction(() => /MP-DUP0/.test(document.querySelector("#unit-form")?.textContent || ""), null, { timeout: 15000 }).catch(async () => {
    throw new Error(`duplicate: no look-alike warning at Next. Page says: ${await pageSays(pg)}`);
  });
  expect(await visibleStep(pg)).toBe(1);
  await next(pg, "duplicate: Next again after the warning");
  await toSave(pg, opts, "duplicate", { from: 2 });
  const code = await save(pg, "duplicate accepted");
  expect(code).toBe("MP-DUP1");
  expect(await countLike("MP-DUP")).toBe(2);
  expect(errors).toEqual([]);
  await ctx.close();
});

test("the server saves but its answer is lost: the page checks and opens the saved unit, saved once", async () => {
  const { ctx, pg, errors } = await openAs();
  const opts = await fillUnit(pg, { code: "MP-LOST1", phone: "01033330001" });
  await toSave(pg, opts, "lost answer");
  // The save reaches the server, then the connection drops before the answer gets back.
  await pg.route("**/app/units/new", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fetch();
    await route.abort("connectionreset");
  });
  const code = await save(pg, "lost answer");
  expect(code).toBe("MP-LOST1");
  expect(await countLike("MP-LOST")).toBe(1);
  expect(errors).toEqual([]);
  await ctx.close();
});

test("the server never gets the save: the page says not saved, keeps the form, and Try again saves once", async () => {
  const { ctx, pg, errors } = await openAs();
  const opts = await fillUnit(pg, { code: "MP-NET1", phone: "01044440001" });
  await toSave(pg, opts, "no connection");
  await pg.route("**/app/units/new", (route) => (route.request().method() === "POST" ? route.abort("connectionfailed") : route.continue()));
  await pg.click("#unit-form [data-save-row] button[type=submit]");
  const retry = pg.locator("#unit-form [data-save-status] button", { hasText: /Try again|جرب تاني|حاول/ });
  await retry.waitFor({ timeout: 30000 }).catch(async () => {
    throw new Error(`no connection: no "not saved" message with Try again. Page says: ${await pageSays(pg)}`);
  });
  expect(await countLike("MP-NET")).toBe(0);
  // The form is kept as typed.
  expect(await pg.inputValue('#unit-form [name="code"]')).toBe("MP-NET1");
  await pg.unroute("**/app/units/new");
  await retry.click();
  await pg.waitForURL(/\/app\/units\/MP-NET1\?saved=1/, { timeout: 30000 }).catch(async () => {
    throw new Error(`no connection: Try again did not save. Page says: ${await pageSays(pg)}`);
  });
  expect(await countLike("MP-NET")).toBe(1);
  expect(errors).toEqual([]);
  await ctx.close();
});

test("edit a unit: the new price is saved and the unit page opens", async () => {
  await h.insertListing({ code: "MP-EDIT1", title: "MP-EDIT1", compound: "Hyde Park", price_value: 5e6, area_value: 120, bedrooms: 2, bathrooms: 1 });
  const { ctx, pg, errors } = await openAs();
  await pg.goto(`${BASE}/app/units/MP-EDIT1/edit?lang=en`, { waitUntil: "networkidle" });
  await pg.fill('#unit-form [name="price_value"]', "6 مليون");
  // The edit form may be stepped or one page; walk to Save either way.
  for (let i = 0; i < 5 && !(await pg.locator("#unit-form [data-save-row] button[type=submit]").isVisible()); i++) {
    await next(pg, `edit step ${i + 1}`);
  }
  await pg.waitForSelector("#unit-form [data-review]", { timeout: 15000 });
  if (await pg.locator("#unit-form [data-warn-ack]").count()) await pg.check("#unit-form [data-warn-ack]");
  const code = await save(pg, "edit");
  expect(code).toBe("MP-EDIT1");
  expect(Number((await unit("MP-EDIT1")).price_value)).toBe(6e6);
  expect(errors).toEqual([]);
  await ctx.close();
});

test("search: a typed search finds a unit of this agency and never another agency's", async () => {
  await h.insertListing({ code: "MP-FIND1", title: "MP-FIND1", compound: "Hyde Park", price_value: 8e6, area_value: 160, bedrooms: 3, bathrooms: 2 });
  await h.insertListing({ code: "MP-RIVAL1", title: "MP-RIVAL1", compound: "Hyde Park", price_value: 8e6, area_value: 160, bedrooms: 3, bathrooms: 2, agency_id: h.BROKERS.rival.agency_id });
  const { ctx, pg, errors } = await openAs();
  await pg.goto(`${BASE}/app/search?lang=en`, { waitUntil: "networkidle" });
  const box = pg.locator('form [name="q"]').first();
  await box.fill("apartment in Hyde Park 3 bedrooms");
  await box.press("Enter");
  await pg.waitForLoadState("networkidle");
  const text = await pg.textContent("body");
  if (!/MP-FIND1/.test(text)) throw new Error(`search: MP-FIND1 not in the results. Page says: ${text.replace(/\s+/g, " ").slice(0, 400)}`);
  expect(text).not.toMatch(/MP-RIVAL1/);
  expect(errors).toEqual([]);
  await ctx.close();
});
