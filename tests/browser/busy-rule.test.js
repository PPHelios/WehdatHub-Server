// tests/browser/busy-rule.test.js — The busy rule (plan 12): while a server call runs, the control that started it spins
// and every other button, field, dropdown and button-link is disabled; all of it is restored when the call ends, when it
// fails, and when the page is shown again. Runs on a small page: no server, no network. Needs Chromium + Playwright.
"use strict";

const path = require("path");
const { chromium } = require("playwright");

jest.setTimeout(120000);

const PAGE = `<!doctype html><html><body>
<main>
  <button id="a" type="button">Save</button>
  <button id="b" type="button">Other</button>
  <a id="l" class="btn" href="/x">Link</a>
  <select id="s"><option>1</option></select>
  <input id="i" value="x">
  <textarea id="t"></textarea>
  <button id="was-off" type="button" disabled>Already off</button>
  <div data-no-lock><button id="free" type="button">Free</button></div>
  <button id="poll" type="button" hx-trigger="every 2s">Poll</button>
</main></body></html>`;

let browser, page;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  if (browser) await browser.close();
});
beforeEach(async () => {
  page = await browser.newPage();
  await page.setContent(PAGE);
  await page.addScriptTag({ path: path.join(__dirname, "..", "..", "web", "static", "busy.js") });
});
afterEach(async () => page.close());

const state = (sel) => page.$eval(sel, (el) => ({ disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true", busy: el.classList.contains("busy") }));

test("the button that started the call spins; every other control is disabled", async () => {
  await page.evaluate(() => { window.__end = window.whBusy.start(document.getElementById("a")); });
  expect((await state("#a")).busy).toBe(true);
  for (const sel of ["#b", "#l", "#s", "#i", "#t"]) {
    const s = await state(sel);
    expect([sel, s.disabled, s.busy]).toEqual([sel, true, false]); // disabled, and no spinner on the others
  }
  expect((await state("#free")).disabled).toBe(false); // data-no-lock stays usable
  await page.evaluate(() => window.__end());
});

test("everything is restored when the call ends, and a control that was already disabled stays disabled", async () => {
  await page.evaluate(() => { window.__end = window.whBusy.start(document.getElementById("a")); window.__end(); });
  for (const sel of ["#a", "#b", "#l", "#s", "#i", "#t"]) {
    const s = await state(sel);
    expect([sel, s.disabled, s.busy]).toEqual([sel, false, false]);
  }
  expect((await state("#was-off")).disabled).toBe(true);
  expect(await page.evaluate(() => window.whBusy.active())).toBe(false);
});

test("a failed request (htmx error events) does not leave the page stuck", async () => {
  await page.evaluate(() => {
    const a = document.getElementById("a");
    document.dispatchEvent(Object.assign(new Event("htmx:beforeRequest"), { detail: { elt: a } }));
  });
  expect((await state("#b")).disabled).toBe(true);
  await page.evaluate(() => {
    document.dispatchEvent(Object.assign(new Event("htmx:responseError"), { detail: { elt: document.getElementById("a") } }));
  });
  expect((await state("#b")).disabled).toBe(false);
  expect((await state("#a")).busy).toBe(false);
});

test("two calls at once: the page stays locked until the last one ends; a poll never locks", async () => {
  await page.evaluate(() => {
    window.__e1 = window.whBusy.start(document.getElementById("a"));
    window.__e2 = window.whBusy.start(document.getElementById("b"));
    window.__e0 = window.whBusy.start(document.getElementById("poll"));
    window.__e1();
  });
  expect(await page.evaluate(() => window.whBusy.active())).toBe(true);
  expect((await state("#i")).disabled).toBe(true);
  await page.evaluate(() => window.__e2());
  expect((await state("#i")).disabled).toBe(false);
});

test("coming back from the back/forward cache unlocks the page", async () => {
  await page.evaluate(() => { window.whBusy.start(document.getElementById("a")); window.dispatchEvent(new Event("pageshow")); });
  expect((await state("#b")).disabled).toBe(false);
});

test("a background check marked data-no-lock (the lead form's duplicate-phone check) never locks the page", async () => {
  await page.evaluate(() => {
    const phone = document.getElementById("i");
    phone.setAttribute("data-no-lock", "");
    document.dispatchEvent(Object.assign(new Event("htmx:beforeRequest"), { detail: { elt: phone, requestConfig: {} } }));
  });
  expect(await page.evaluate(() => window.whBusy.active())).toBe(false);
  expect((await state("#a")).disabled).toBe(false);
  expect((await state("#b")).disabled).toBe(false);
});

test("a plain POST form is locked by the busy rule alone: every control disabled, the tapped button spins, restored when the call ends", async () => {
  await page.route("http://t.test/", (r) => r.fulfill({ contentType: "text/html", body: `<!doctype html><body><form method="post" action="/save"><input id="f" value="x"><button id="go" type="submit">Save</button><button id="other" type="button">Other</button></form></body>` }));
  await page.route("http://t.test/save", async (r) => { await new Promise((x) => setTimeout(x, 700)); r.fulfill({ status: 204 }); });
  await page.goto("http://t.test/");
  await page.addScriptTag({ path: path.join(__dirname, "..", "..", "web", "static", "busy.js") });
  await page.click("#go", { noWaitAfter: true });
  await page.waitForTimeout(250);
  expect((await state("#f")).disabled).toBe(true);
  expect((await state("#other")).disabled).toBe(true);
  expect((await state("#go")).busy).toBe(true);
  await page.waitForTimeout(1200);
});
