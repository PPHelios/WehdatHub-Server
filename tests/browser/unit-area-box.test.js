// tests/browser/unit-area-box.test.js — The unit form in a real browser: the Area and Sub-zone boxes (typing picks the area in
// either language or by alias, the sub-zone list follows the area), and the review and Save gate on a form that "Fill from
// text" swapped in.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");

process.env.PUBLIC_BASE_URL = "http://127.0.0.1:4581";
jest.setTimeout(120000);

const BASE = "http://127.0.0.1:4581";
const NC = "a0000000-0000-0000-0000-0000000000c1"; // New Cairo, seeded by the harness
const OCT = "a0000000-0000-0000-0000-0000000000c2";
const BAN = "a0000000-0000-0000-0000-0000000000c3";
const ZAY = "a0000000-0000-0000-0000-0000000000c4";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
let h, browser, server;

beforeAll(async () => {
  h = await createHarness();
  const add = (id, en, ar, aliases, parent) =>
    h.query("INSERT INTO areas (id, name_key, name_en, name_ar, aliases, parent_id) VALUES ($1, $2, $3, $4, $5, $6)", [id, en.toLowerCase(), en, ar, aliases, parent]);
  await add(OCT, "6th of October", "6 أكتوبر", ["october"], null);
  await add(BAN, "Al Banafseg", "البنفسج", [], NC);
  await add(ZAY, "Sheikh Zayed", "الشيخ زايد", [], OCT);
  const { chromium } = require("playwright");
  browser = await chromium.launch({ args: ["--no-sandbox"] });
  server = h.app.app.listen(4581);
});

afterAll(async () => {
  if (browser) await browser.close();
  if (server) server.close();
  await closeHarness();
});

/** A signed-in page on the new-unit form; `init` runs in the page before any of its scripts. */
async function openForm(lang = "en", init = null) {
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  if (init) await ctx.addInitScript(init.fn, init.arg);
  const pg = await ctx.newPage();
  const br = h.BROKERS.broker;
  const token = await WebAuth.issueLoginToken(h.pool, { id: br.id, agency_id: br.agency_id });
  await pg.goto(`${BASE}/app/login/confirm?t=${token}`);
  await pg.click("form button[type=submit], form input[type=submit]");
  await pg.waitForLoadState("networkidle");
  await pg.goto(`${BASE}/app/units/new?lang=${lang}`, { waitUntil: "networkidle" });
  return { ctx, pg };
}

/** Types a compound the list does not know, so the add-new part (with the area boxes) opens. */
async function openNewCompound(pg) {
  await pg.fill("input[data-place-suggest]", "zzzzzzzz");
  await pg.locator("input[data-place-suggest]").blur();
  await pg.waitForTimeout(500);
  if ((await pg.locator("[data-place-new]").getAttribute("hidden")) !== null) await pg.locator("[data-place-add]").click();
}

const areaBox = (pg) => pg.locator('input[data-area-input="area_id"]');
const subBox = (pg) => pg.locator('input[data-area-input="subzone_id"]');
const areaId = (pg) => pg.locator('select[name="area_id"]').inputValue();
const subId = (pg) => pg.locator('select[name="subzone_id"]').inputValue();
const listOf = (pg, name) => pg.locator(`datalist#${name}-list option`).evaluateAll((os) => os.map((o) => o.value));

test("typing a name in either language, or an alias, picks the area (page in English)", async () => {
  const { ctx, pg } = await openForm("en");
  await openNewCompound(pg);
  await areaBox(pg).fill("new cairo");
  expect(await areaId(pg)).toBe(NC);
  await areaBox(pg).fill("القاهرة الجديدة");
  expect(await areaId(pg)).toBe(NC);
  await areaBox(pg).fill("october");
  expect(await areaId(pg)).toBe(OCT);
  await areaBox(pg).fill("6 اكتوبر"); // أ typed as ا still finds it
  expect(await areaId(pg)).toBe(OCT);
  await ctx.close();
});

test("the suggestion list holds every name and alias of the areas", async () => {
  const { ctx, pg } = await openForm("en");
  await openNewCompound(pg);
  await areaBox(pg).click();
  const terms = await listOf(pg, "area_id");
  expect(terms).toEqual(expect.arrayContaining(["New Cairo", "القاهرة الجديدة", "6th of October", "6 أكتوبر", "october"]));
  expect(terms).not.toContain("Al Banafseg"); // a sub-zone is not an area
  await ctx.close();
});

test("a name that is not in the list is flagged, a listed one is not", async () => {
  const { ctx, pg } = await openForm("en");
  await openNewCompound(pg);
  await areaBox(pg).fill("zzz");
  expect(await areaId(pg)).toBe("");
  expect(await areaBox(pg).evaluate((el) => el.validationMessage)).not.toBe("");
  await areaBox(pg).fill("New Cairo");
  expect(await areaBox(pg).evaluate((el) => el.validationMessage)).toBe("");
  await areaBox(pg).fill("");
  expect(await areaBox(pg).evaluate((el) => el.validity.customError)).toBe(false); // empty is for "required" to judge
  await ctx.close();
});

test("typing does not write the hidden select unless the picked area changes (Chrome stops refreshing its list otherwise)", async () => {
  const { ctx, pg } = await openForm("en", {
    fn: () => {
      window.__selWrites = 0;
      const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
      Object.defineProperty(HTMLSelectElement.prototype, "value", {
        get: d.get,
        set(v) { window.__selWrites++; return d.set.call(this, v); },
        configurable: true
      });
    }
  });
  await openNewCompound(pg);
  await areaBox(pg).click();
  await pg.evaluate(() => { window.__selWrites = 0; });
  await pg.keyboard.type("new c", { delay: 20 });
  expect(await pg.evaluate(() => window.__selWrites)).toBe(0);
  await pg.keyboard.type("airo", { delay: 20 }); // now it is a whole name: one write
  expect(await pg.evaluate(() => window.__selWrites)).toBe(1);
  expect(await areaId(pg)).toBe(NC);
  await pg.keyboard.type("x", { delay: 20 }); // no longer a name: one write back to nothing
  expect(await pg.evaluate(() => window.__selWrites)).toBe(2);
  expect(await areaId(pg)).toBe("");
  await ctx.close();
});

test("the sub-zone list follows the chosen area, and a sub-zone of another area is dropped", async () => {
  const { ctx, pg } = await openForm("en");
  await openNewCompound(pg);
  await areaBox(pg).fill("New Cairo");
  await subBox(pg).click();
  const first = await listOf(pg, "subzone_id");
  expect(first).toEqual(expect.arrayContaining(["Al Banafseg", "البنفسج"]));
  expect(first).not.toContain("Sheikh Zayed");
  await subBox(pg).fill("البنفسج");
  expect(await subId(pg)).toBe(BAN);

  await areaBox(pg).fill("6th of October");
  expect(await subId(pg)).toBe(""); // Al Banafseg belongs to New Cairo
  expect(await subBox(pg).inputValue()).toBe("");
  const second = await listOf(pg, "subzone_id");
  expect(second).toContain("Sheikh Zayed");
  expect(second).not.toContain("Al Banafseg");
  await ctx.close();
});

test("a sub-zone of the chosen area stays when the same area is typed again", async () => {
  const { ctx, pg } = await openForm("en");
  await openNewCompound(pg);
  await areaBox(pg).fill("New Cairo");
  await subBox(pg).fill("Al Banafseg");
  expect(await subId(pg)).toBe(BAN);
  await areaBox(pg).fill("new cairo");
  expect(await subId(pg)).toBe(BAN);
  await ctx.close();
});

test("changing the area or sub-zone is a change event, so the review and the Save check hear it", async () => {
  const { ctx, pg } = await openForm("en");
  await openNewCompound(pg);
  await pg.evaluate(() => {
    window.__changes = [];
    document.addEventListener("change", (e) => { if (e.target.name) window.__changes.push(e.target.name); }, true);
  });
  await areaBox(pg).fill("New Cairo");
  await subBox(pg).fill("Al Banafseg");
  const seen = await pg.evaluate(() => window.__changes);
  expect(seen).toEqual(expect.arrayContaining(["area_id", "subzone_id"]));
  await ctx.close();
});

// "Fill from text" and voice replace the whole #unit-form. The review and the Save gate were set up for the first form only.
async function swapInFilledForm(pg) {
  await pg.evaluate(() => { document.getElementById("unit-form").__first = true; });
  await pg.fill("textarea[name=describe]", "شقة للبيع في التجمع 3 غرف 13.5 مليون");
  await pg.click("[data-ai=unit_fill]");
  await pg.waitForFunction(() => !document.getElementById("unit-form").__first && !!document.querySelector("[data-review]"), null, { timeout: 15000 });
}
const warnings = (pg) => pg.evaluate(() => [...document.querySelectorAll("[data-warning]")].map((w) => w.getAttribute("data-warning")));
const saveDisabled = (pg) => pg.evaluate(() => document.querySelector("[data-save-row] button[type=submit]").disabled);

test("after Fill from text the review loads on the new form and Save stays closed", async () => {
  const { ctx, pg } = await openForm("en");
  await swapInFilledForm(pg);
  expect(await warnings(pg)).toContain("photos");
  expect(await saveDisabled(pg)).toBe(true);
  await ctx.close();
});

test("after Fill from text, adding photos clears the 'photos not recorded' warning", async () => {
  const { ctx, pg } = await openForm("en");
  await swapInFilledForm(pg);
  expect(await warnings(pg)).toContain("photos");
  await pg.setInputFiles("input[data-photo-tray]", [
    { name: "a.png", mimeType: "image/png", buffer: PNG },
    { name: "b.png", mimeType: "image/png", buffer: PNG }
  ]);
  await pg.waitForFunction(() => ![...document.querySelectorAll("[data-warning]")].some((w) => w.getAttribute("data-warning") === "photos"), null, { timeout: 15000 });
  await ctx.close();
});

test("after Fill from text, Save is closed while the warnings box is unticked and opens when it is ticked", async () => {
  const { ctx, pg } = await openForm("en");
  // A review with a warning and no blocker: only the tick decides.
  await pg.route("**/app/units/review", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: '<section class="card" data-review="ok"><ul><li data-warning="finishing">Finishing not recorded</li></ul><label class="check"><input type="checkbox" data-warn-ack> I checked</label><p data-ack-hint>Tick it</p></section>'
    })
  );
  await swapInFilledForm(pg);
  expect(await saveDisabled(pg)).toBe(true);
  await pg.check("[data-warn-ack]");
  await pg.waitForFunction(() => !document.querySelector("[data-save-row] button[type=submit]").disabled, null, { timeout: 8000 });
  await pg.uncheck("[data-warn-ack]");
  expect(await saveDisabled(pg)).toBe(true);
  await pg.waitForTimeout(1500); // the review runs again; an unticked box keeps Save closed
  expect(await saveDisabled(pg)).toBe(true);
  await ctx.close();
});
