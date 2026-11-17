// tests/browser/word-fields.test.js — the Excel review's unknown-words panel: only the picked field's value control is shown,
// and the compound box fills its suggestion list from /app/places/suggest. Needs Chromium + Playwright.
"use strict";

const path = require("path");
const { chromium } = require("playwright");

jest.setTimeout(120000);

const PAGE = `<!doctype html><html><body>
<form data-word-form>
  <select name="field" data-word-field><option value="type">type</option><option value="compound">compound</option><option value="floor" selected>floor</option><option value="notes">notes</option></select>
  <label data-word-val="type"><select name="v_type"><option>villa</option></select></label>
  <label data-word-val="compound"><input name="v_compound" list="wp-0" data-place-search><datalist id="wp-0"></datalist></label>
  <label data-word-val="floor"><input name="v_floor" value="3"></label>
</form></body></html>`;

let browser, page;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  if (browser) await browser.close();
});
beforeEach(async () => {
  page = await browser.newPage();
  await page.route("**/app/places/suggest*", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [{ kind: "compound", label: "ميفيدا", name_en: "Mivida", name_ar: "ميفيدا", path: "القاهرة الجديدة" }, { kind: "area", label: "التجمع", name_en: "Tagamoa" }] }) }));
  await page.setContent(PAGE);
  await page.addScriptTag({ path: path.join(__dirname, "..", "..", "web", "static", "wordfields.js") });
});
afterEach(async () => page.close());

const hidden = (sel) => page.$eval(sel, (e) => e.hidden);
const disabled = (sel) => page.$eval(sel, (e) => e.disabled);

test("only the picked field's value is shown and enabled", async () => {
  expect(await hidden('[data-word-val="floor"]')).toBe(false);
  expect(await hidden('[data-word-val="compound"]')).toBe(true);
  expect(await disabled('[name="v_compound"]')).toBe(true);
  await page.selectOption("[data-word-field]", "compound");
  expect(await hidden('[data-word-val="compound"]')).toBe(false);
  expect(await disabled('[name="v_compound"]')).toBe(false);
  expect(await hidden('[data-word-val="floor"]')).toBe(true);
  expect(await disabled('[name="v_floor"]')).toBe(true);
  await page.selectOption("[data-word-field]", "notes");
  expect(await hidden('[data-word-val="compound"]')).toBe(true);
});

test("typing in the compound box offers compounds from the list (not areas)", async () => {
  await page.selectOption("[data-word-field]", "compound");
  await page.fill('[name="v_compound"]', "miv");
  await page.waitForFunction(() => document.querySelectorAll("#wp-0 option").length > 0);
  const opts = await page.$$eval("#wp-0 option", (os) => os.map((o) => o.value));
  expect(opts).toEqual(["Mivida"]);
});
