// tests/web/arrow-direction.test.js — Arrows point the way the page reads (QA round 3, step 2). "←" and "→" are not mirrored
// by the browser in Arabic (unlike ‹ › « »), so a page that uses them picks them by language: "previous" points right in
// Arabic and left in English. The back icon flips in English; the Today "Open" icon flips in Arabic (web/static/app.css).
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const fs = require("fs");
const path = require("path");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");

jest.setTimeout(60000);
let h;
beforeAll(async () => { h = await createHarness(); });
afterAll(closeHarness);

test("the commissions period arrows follow the language", async () => {
  await h.seedBroker("owner");
  const { agent } = await signIn(h, "owner");
  const ar = (await agent.get("/app/commissions?lang=ar")).text;
  const en = (await agent.get("/app/commissions?lang=en")).text;
  if (ar.includes('aria-label="السابق"')) {
    expect(ar).toContain('aria-label="السابق">→<');
    expect(ar).toContain('aria-label="التالي">←<');
  }
  if (en.includes('aria-label="Previous"')) {
    expect(en).toContain('aria-label="Previous">←<');
    expect(en).toContain('aria-label="Next">→<');
  }
});

test("icon flips: Back flips in English, Today's Open flips in Arabic", () => {
  const css = fs.readFileSync(path.join(__dirname, "../../web/static/app.css"), "utf8");
  expect(css).toMatch(/\[dir="ltr"\] \.backlink \.ico \{ transform: scaleX\(-1\); \}/);
  expect(css).toMatch(/\[dir="rtl"\] \.task \.actions \.btn:last-child \.ico \{ transform: scaleX\(-1\); \}/);
});
