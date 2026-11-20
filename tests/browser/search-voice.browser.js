// tests/browser/search-voice.browser.js — runs the search page's JavaScript in Chromium (Playwright) against the
// harness: Enter, the searching state, the mic (AI note, phone fallback, denied permission) and no listening on load.
// Run: npm run test:browser. Prints failures only.
"use strict";

const path = require("path");
const R = path.resolve(__dirname, "../..");
const Module = require("module");
const orig = Module._resolveFilename;
const map = { "lib/whatsapp": "tests/harness/fake-whatsapp", "lib/ai": "tests/harness/fake-ai", "lib/supabase": "tests/harness/fake-supabase" };
Module._resolveFilename = function (req, parent, ...a) {
  const p = orig.call(this, req, parent, ...a);
  if (!global.__bypass) for (const [k, v] of Object.entries(map)) if (p === path.join(R, `${k}.js`)) return path.join(R, `${v}.js`);
  return p;
};
// The harness mocks are written for jest; this gives them the two calls they use.
global.jest = {
  requireActual: (rel) => { global.__bypass = true; try { return require(require("path").resolve(R, "tests/harness", rel)); } finally { global.__bypass = false; } },
  fn: (f) => f || (() => {})
};
process.env.PUBLIC_BASE_URL = "http://localhost:4570";

const { chromium } = require("playwright");
const { createHarness, closeHarness } = require(`${R}/tests/harness/app`);
const WebAuth = require(`${R}/lib/webAuth`);

// Fakes for the browser: a microphone that records, a recorder, and the phone's speech recognition.
const FAKES = `
window.__calls = { gum: 0, speech: 0 };
navigator.mediaDevices.getUserMedia = async () => {
  window.__calls.gum++;
  if (window.__deny) throw new DOMException("denied", "NotAllowedError");
  return { getTracks: () => [{ stop() {} }] };
};
class FakeRecorder {
  constructor() { this.mimeType = "audio/webm"; }
  start() {}
  stop() {
    this.ondataavailable && this.ondataavailable({ data: new Blob(["note"], { type: "audio/webm" }) });
    this.onstop && this.onstop();
  }
}
FakeRecorder.isTypeSupported = () => true;
window.MediaRecorder = window.__noRecorder ? undefined : FakeRecorder;
class FakeSpeech {
  start() {
    window.__calls.speech++;
    setTimeout(() => {
      this.onresult && this.onresult({ results: [[{ transcript: "شقة ٣ غرف" }]] });
      this.onend && this.onend();
    }, 50);
  }
  stop() { this.onend && this.onend(); }
  abort() { this.onend && this.onend(); }
}
window.SpeechRecognition = FakeSpeech;
`;

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) { failures++; console.log(`FAIL ${name}${detail ? `: ${detail}` : ""}`); }
}

async function signedIn(browser, h, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await ctx.addInitScript((opts.noRecorder ? "window.__noRecorder = true;" : "") + (opts.deny ? "window.__deny = true;" : "") + FAKES);
  const pg = await ctx.newPage();
  pg.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  if (process.env.DBG) pg.on("console", (m) => console.log("CONSOLE", m.text()));
  const b = h.BROKERS.broker;
  const token = await WebAuth.issueLoginToken(h.pool, { id: b.id, agency_id: b.agency_id });
  await pg.goto(`${BASE}/app/login/confirm?t=${token}`);
  await pg.click("form button[type=submit], form input[type=submit]");
  await pg.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 15000 });
  return { ctx, pg };
}

const BASE = "http://localhost:4570";

(async () => {
  const h = await createHarness();
  h.AI.respond((c) => (c.operation === "transcribe" ? "شقة 3 غرف" : null));
  const server = h.app.app.listen(4570);
  const browser = await chromium.launch();
  try {
    // 1. Enter searches the typed text and leaves the page for the results.
    {
      const { ctx, pg } = await signedIn(browser, h);
      await pg.goto(`${BASE}/app/search`);
      await pg.fill("input[name=q]", "شقة 3 غرف");
      await pg.press("input[name=q]", "Enter");
      await pg.waitForURL(/\/app\/search\?/, { timeout: 15000 }).catch(() => {});
      check("Enter searches typed text", /\/app\/search\?/.test(pg.url()), pg.url());
      await ctx.close();
    }
    // 2. Enter on an empty box does nothing.
    {
      const { ctx, pg } = await signedIn(browser, h);
      await pg.goto(`${BASE}/app/search`);
      const before = pg.url();
      await pg.press("input[name=q]", "Enter");
      await pg.waitForTimeout(500);
      check("Enter on empty box does nothing", pg.url() === before, pg.url());
      await ctx.close();
    }
    // 3. ?voice=1 never starts listening on load.
    {
      const { ctx, pg } = await signedIn(browser, h);
      await pg.goto(`${BASE}/app/search?voice=1`);
      await pg.waitForTimeout(800);
      const calls = await pg.evaluate(() => window.__calls);
      check("no listening on load", calls.gum === 0 && calls.speech === 0, JSON.stringify(calls));
      await ctx.close();
    }
    // 4. The mic records a note; the AI writes it down; the search runs on the text.
    {
      const { ctx, pg } = await signedIn(browser, h);
      await pg.goto(`${BASE}/app/search`);
      await pg.click(".mic");
      await pg.waitForSelector(".mic.recording", { timeout: 5000 }).catch(() => {});
      check("mic shows recording state", await pg.$(".mic.recording") !== null);
      if (process.env.DBG) console.log(await pg.evaluate(() => JSON.stringify({ w: typeof window.WHRail, f: document.querySelector("form").className, b: document.querySelector(".mic").className, rail: !!document.querySelector(".vrail"), calls: window.__calls })));
      const voice = pg.waitForResponse((r) => r.url().includes("/app/search/voice"), { timeout: 10000 });
      await pg.click(".mic");
      const res = await voice;
      check("AI note request succeeds", res.status() === 200, res.status() === 200 ? "" : String(res.status()) + " " + (await res.text().catch(() => "")));
      await pg.waitForURL(/\/app\/search\?/, { timeout: 15000 }).catch(() => {});
      check("AI note leads to a search", /\/app\/search\?/.test(pg.url()), pg.url());
      await ctx.close();
    }
    // 5. The AI is down: a message says to tap again, and the next tap uses the phone's speech.
    {
      const { ctx, pg } = await signedIn(browser, h);
      await pg.route("**/app/search/voice", (r) => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "The AI is unavailable right now.", fallback: true }) }));
      await pg.goto(`${BASE}/app/search`);
      await pg.click(".mic");
      await pg.waitForSelector(".mic.recording", { timeout: 5000 }).catch(() => {});
      await pg.click(".mic");
      await pg.waitForSelector("[data-toast-box]:not([hidden])", { timeout: 5000 }).catch(() => {});
      const toast = await pg.textContent("[data-toast-box]");
      check("AI down shows the server's message", /unavailable/.test(toast || ""), toast);
      check("mic is not stuck after AI down", (await pg.$(".mic.recording, .mic.busy")) === null);
      await pg.unroute("**/app/search/voice");
      await pg.click(".mic");
      await pg.waitForURL(/\/app\/search\?/, { timeout: 15000 }).catch(() => {});
      check("next tap uses phone speech and searches", /\/app\/search\?/.test(pg.url()), pg.url());
      await ctx.close();
    }
    // 6. Permission denied: a clear message, mic back to idle.
    {
      const { ctx, pg } = await signedIn(browser, h, { deny: true });
      await pg.goto(`${BASE}/app/search`);
      await pg.click(".mic");
      await pg.waitForSelector("[data-toast-box]:not([hidden])", { timeout: 5000 }).catch(() => {});
      const toast = await pg.textContent("[data-toast-box]");
      check("denied permission shows a message", /microphone|للمايك/.test(toast || ""), toast);
      check("mic idle after denial", (await pg.$(".mic.recording")) === null);
      await ctx.close();
    }
    // 7. No recorder in the browser: the phone's speech is used and searches.
    {
      const { ctx, pg } = await signedIn(browser, h, { noRecorder: true });
      await pg.goto(`${BASE}/app/search`);
      await pg.click(".mic");
      await pg.waitForURL(/\/app\/search\?/, { timeout: 15000 }).catch(() => {});
      check("phone speech searches when no recorder", /\/app\/search\?/.test(pg.url()), pg.url());
      await ctx.close();
    }
    // 8. The round button: mic when empty, send arrow when typed (a submit); home has it too.
    {
      const { ctx, pg } = await signedIn(browser, h);
      await pg.goto(`${BASE}/app/search`);
      const label0 = await pg.getAttribute(".sb-act", "aria-label");
      await pg.fill("input[name=q]", "شقة 3 غرف");
      check("typed text turns the mic into send", (await pg.$(".sb.has-text")) !== null);
      check("send label differs from mic label", (await pg.getAttribute(".sb-act", "aria-label")) !== label0);
      const box = await pg.$eval(".sb-act", (b) => { const r = b.getBoundingClientRect(); return { r: r.right, w: r.width, h: r.height, vw: innerWidth }; });
      check("round button is 44px and on the right", box.w >= 44 && box.h >= 44 && box.r > box.vw / 2, JSON.stringify(box));
      await pg.click(".sb-act");
      await pg.waitForURL(/\/app\/search\?/, { timeout: 15000 }).catch(() => {});
      check("send button searches", /[?&]q=/.test(pg.url()), pg.url());
      await ctx.close();
    }
    // 9. Recording rail: shows, then the bin discards, restores the input and sends nothing.
    {
      const { ctx, pg } = await signedIn(browser, h);
      let posted = 0;
      pg.on("request", (r) => { if (r.url().includes("/app/search/voice")) posted++; });
      await pg.goto(`${BASE}/app/search`);
      await pg.click(".sb-act");
      await pg.waitForSelector(".vrail .vr-time", { timeout: 5000 }).catch(() => {});
      check("recording rail shows", (await pg.$(".sb.is-rec .vrail")) !== null);
      check("input hidden while recording", !(await pg.isVisible("input[name=q]")));
      check("focus moves to send", await pg.evaluate(() => document.activeElement && document.activeElement.matches(".sb-act")));
      await pg.click(".vr-bin");
      await pg.waitForSelector(".vrail", { state: "detached", timeout: 3000 }).catch(() => {});
      check("input back after discard", await pg.isVisible("input[name=q]"));
      check("focus back on input after discard", await pg.evaluate(() => document.activeElement && document.activeElement.matches("input[name=q]")));
      check("discard sends nothing", posted === 0, String(posted));
      // Esc discards too.
      await pg.click(".sb-act");
      await pg.waitForSelector(".vrail .vr-time", { timeout: 5000 }).catch(() => {});
      await pg.keyboard.press("Escape");
      await pg.waitForSelector(".vrail", { state: "detached", timeout: 3000 }).catch(() => {});
      check("Esc discards", (await pg.isVisible("input[name=q]")) && posted === 0);
      await ctx.close();
    }
    // 10. Home: the same round button submits typed text and records in place.
    {
      const { ctx, pg } = await signedIn(browser, h);
      await pg.goto(`${BASE}/app`);
      check("home has the round button", (await pg.$(".sb-act[data-mic]")) !== null);
      await pg.click(".sb-act");
      await pg.waitForSelector(".sb.is-rec", { timeout: 5000 }).catch(() => {});
      check("home records in place", /\/app\/?$/.test(pg.url()) && (await pg.$(".sb.is-rec .vrail")) !== null, pg.url());
      await pg.click(".vr-bin");
      await pg.waitForSelector(".vrail", { state: "detached", timeout: 3000 }).catch(() => {});
      await pg.fill("input[name=q]", "شقة");
      await pg.click(".sb-act");
      await pg.waitForURL(/\/app\/search\?/, { timeout: 15000 }).catch(() => {});
      check("home send searches", /\/app\/search\?/.test(pg.url()), pg.url());
      await ctx.close();
    }
  } catch (err) {
    failures++;
    console.log(`FAIL run: ${err.message}`);
  } finally {
    await browser.close();
    server.close();
    await closeHarness();
  }
  if (failures) { console.log(`${failures} browser check(s) failed`); process.exit(1); }
})();
