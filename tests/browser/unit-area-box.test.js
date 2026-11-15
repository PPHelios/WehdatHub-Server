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
  // An approved compound in New Cairo that is also in the Al Banafseg zone (the box shows both).
  // (The location import already loads Hyde Park: it is moved to New Cairo here and given the zone.)
  const hyde = await h.query("UPDATE map_places SET approved = true, area_id = $1, subzone_id = NULL WHERE name_key = 'hyde park' RETURNING id", [NC]);
  await h.query("INSERT INTO place_zones (place_id, area_id) VALUES ($1, $2)", [hyde[0].id, BAN]);
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

/** Types a place the list does not know and asks for it as new, so the add-new part (with the area boxes) opens. */
async function openNewCompound(pg) {
  await pg.fill("[data-ubox-input]", "zzzzzzzz");
  await pg.locator("[data-ubox-list] [data-i]", { hasText: /request a new place/i }).click();
  await pg.locator("[data-ubox-new]").waitFor({ state: "visible" });
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

// ---- the one box: place and features as chips ----
const chips = (pg, kind) => pg.locator(`[data-ubox-chip="${kind}"] [data-chip-text]`).allTextContents();
const hidden = (pg, name) => pg.locator(`input[type=hidden][name="${name}"]`).evaluateAll((els) => els.map((e) => e.value));

test("typing a compound picks it as the one place chip, with its area and zones; picking another replaces it", async () => {
  const { ctx, pg } = await openForm("en");
  await pg.fill("[data-ubox-input]", "hyde");
  await pg.locator("[data-ubox-list] [data-i]", { hasText: "Hyde Park" }).first().click();
  expect(await chips(pg, "place")).toEqual(["Hyde Park"]);
  expect(await hidden(pg, "compound")).toEqual(["Hyde Park"]);
  expect(await areaId(pg)).toBe(NC);
  expect(await pg.locator("[data-ubox-context]").textContent()).toContain("Al Banafseg");
  expect(await pg.locator("[data-ubox-new]").getAttribute("hidden")).not.toBeNull();
  // An alias finds it too, and a second place replaces the first.
  await pg.fill("[data-ubox-input]", "zayed");
  await pg.locator("[data-ubox-list] [data-i]", { hasText: /^Sheikh Zayed/ }).first().click();
  expect(await chips(pg, "place")).toEqual(["Sheikh Zayed"]);
  expect(await hidden(pg, "compound")).toEqual([""]);
  expect(await areaId(pg)).toBe(OCT); // a sub-zone is saved with its area
  expect(await subId(pg)).toBe(ZAY);
  await ctx.close();
});

test("a feature is a chip that writes the same field the checkboxes did, and removing it takes it out", async () => {
  const { ctx, pg } = await openForm("en");
  await pg.fill("[data-ubox-input]", "roof");
  await pg.locator("[data-ubox-list] [data-i]", { hasText: /^Roof/ }).first().click();
  expect(await chips(pg, "feature")).toEqual(["Roof"]);
  expect(await hidden(pg, "feature")).toEqual(["roof"]);
  await pg.locator('[data-ubox-chip="feature"] [data-ubox-remove]').click();
  expect(await hidden(pg, "feature")).toEqual([]);
  // Words the dictionary does not know stay as free text.
  await pg.fill("[data-ubox-input]", "jacuzzi");
  await pg.locator("[data-ubox-list] [data-i]", { hasText: /add .jacuzzi. as another feature/i }).click();
  expect(await chips(pg, "other")).toEqual(["jacuzzi not in the list"].map((t) => expect.stringContaining("jacuzzi")));
  expect(await hidden(pg, "features_other")).toEqual(["jacuzzi"]);
  await ctx.close();
});

test("pasting a message into the box reads the place and the features, free", async () => {
  const { ctx, pg } = await openForm("en");
  await pg.fill("textarea[name=describe]", "شقة للبيع في هايد بارك 150 متر 3 غرف بحري روف");
  await pg.locator("textarea[name=describe]").blur();
  await pg.waitForFunction(() => document.querySelectorAll('[data-ubox-chip="place"]').length === 1, null, { timeout: 8000 });
  expect(await chips(pg, "place")).toEqual(["Hyde Park"]); // the chip is in the page's language, whichever language was pasted
  expect((await hidden(pg, "feature")).sort()).toEqual(["north_facing", "roof"]);
  await ctx.close();
});

// ---- sale and rent ----
const stepNames = (pg) => pg.locator(".stepbar .stepdot").allTextContents();

test("a rental skips the delivery and payment step and shows the rent period; a sale hides the rent period", async () => {
  const { ctx, pg } = await openForm("en");
  expect(await stepNames(pg)).toEqual(["1. Unit and place", "2. Size and price", "3. Delivery and payment", "4. Owner and photos"]);
  await pg.selectOption("select[name=listing_type]", "rent");
  expect(await stepNames(pg)).toEqual(["1. Unit and place", "2. Size and price", "3. Owner and photos"]);
  await pg.selectOption("select[name=property_type]", "apartment");
  expect(await pg.locator("select[name=rent_period]").isVisible()).toBe(false); // step 2 is not on screen yet
  // A hidden section's fields are disabled, so they are never sent.
  expect(await pg.locator("input[name=delivery_year]").isDisabled()).toBe(true);
  expect(await pg.locator("input[name=remaining_amount]").isDisabled()).toBe(true);
  await pg.selectOption("select[name=listing_type]", "sale");
  expect(await stepNames(pg)).toHaveLength(4);
  expect(await pg.locator("input[name=delivery_year]").isDisabled()).toBe(false);
  expect(await pg.locator("select[name=rent_period]").isDisabled()).toBe(true);
  await ctx.close();
});

test("size fields follow the unit type: land only for houses, and a field that has a value is never hidden", async () => {
  const { ctx, pg } = await openForm("en");
  await pg.selectOption("select[name=property_type]", "apartment");
  expect(await pg.locator("input[name=land_area]").isDisabled()).toBe(true);
  expect(await pg.locator("input[name=floor_level]").isDisabled()).toBe(false);
  await pg.selectOption("select[name=property_type]", "villa");
  expect(await pg.locator("input[name=land_area]").isDisabled()).toBe(false);
  expect(await pg.locator("input[name=floor_level]").isDisabled()).toBe(true); // a house has no floor
  await pg.selectOption("select[name=property_type]", "roof");
  expect(await pg.locator("input[name=roof_area]").isDisabled()).toBe(false);
  await ctx.close();
});

const goStep = (pg, n) => pg.evaluate((k) => document.getElementById("unit-form").dispatchEvent(new CustomEvent("stepgoto", { detail: k })), n);

test("the client description is written from the unit's fields until someone edits it by hand", async () => {
  const { ctx, pg } = await openForm("en");
  await pg.selectOption('select[name="listing_type"]', "sale");
  await pg.selectOption('select[name="property_type"]', "apartment");
  await goStep(pg, 2);
  await pg.fill('input[name="area_value"]', "150");
  await pg.fill('input[name="bedrooms"]', "3");
  await pg.fill('input[name="garden_area"]', "40");
  const text = () => pg.inputValue('textarea[name="clean_summary"]');
  expect(await text()).toMatch(/for sale.*150 m².*3 bedrooms.*garden 40 m²/);
  expect(await chips(pg, "feature")).toContain("Private garden"); // the garden area is the feature too
  await goStep(pg, 4);
  await pg.fill('textarea[name="clean_summary"]', "My own words");
  await goStep(pg, 2);
  await pg.fill('input[name="bedrooms"]', "4");
  expect(await text()).toBe("My own words");
  await goStep(pg, 4);
  await pg.click("[data-draft-again]");
  expect(await text()).toMatch(/4 bedrooms/);
  await ctx.close();
});
