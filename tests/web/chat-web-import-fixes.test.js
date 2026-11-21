// tests/web/chat-web-import-fixes.test.js — QA W02, W03, W08, W18, W19 (web WhatsApp import)
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const fs = require("fs");
const path = require("path");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Imports = require("../../services/imports");
const ChatListing = require("../../domain/chatListing");

jest.setTimeout(90000);
const read = (f) => fs.readFileSync(path.join(__dirname, "../../web/static", f), "utf8");

let h;
beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("manager");
});
afterAll(closeHarness);

test("W02: a refused upload (422) is shown inside the form, not followed as a page", async () => {
  const js = read("app.js");
  expect(js).toMatch(/xhr\.status < 400 && xhr\.responseURL/);
  expect(js).toMatch(/xhr\.status >= 400 && form\.id !== "unit-form"[\s\S]*notice\.bad\[role=alert\]/);
  const { agent, csrf } = await signIn(h, "manager");
  const r = await agent.post("/app/import/group").field("_csrf", csrf).field("range", "custom").field("since", "2999-01-01").attach("chat", Buffer.from(["[24/10/2026, 10:15:32] Ali: شقة للبيع في ميفيدا 200 متر 3 غرف السعر 12 مليون", "[24/10/2026, 10:16:00] Sara: تمام"].join("\n")), { filename: "chat.txt", contentType: "text/plain" });
  expect(r.status).toBe(422);
  expect(r.text).toMatch(/role="alert"[^>]*>🔍/);
});

test("W03: the paste form does not offer Since last import (no earlier import is known there)", async () => {
  const { agent } = await signIn(h, "manager");
  const page = (await agent.get("/app/import")).text;
  const paste = page.slice(page.indexOf("data-paste-import"));
  expect(paste).not.toMatch(/value="last"/);
  expect(page).toMatch(/data-cp-range[\s\S]*value="last"[^>]*hidden disabled/); // the Match tab shows it only once decisions exist
});

test("W08: a re-read of the same chat keeps the range the person chose", () => {
  expect(read("chatphotos.js")).toMatch(/if \(!sameChat\) sel\.value = "last"/);
});

test("W18: Arabic labels with Persian digits and Arabic decimal mark are read as an area", () => {
  const post = (a) => `شقة للبيع في التجمع الخامس\nالمساحة ${a} متر\nالسعر ٣ مليون\n٣ غرف`;
  for (const a of ["150", "١٥٠", "۱۵۰", "١٥٠٫٥"]) expect(ChatListing.parsePost(post(a)).cells.area_value).toBe(a === "١٥٠٫٥" ? "150.5" : "150");
});

test("W19: 45 posts: 40 are read and a notice says 5 were left out", async () => {
  const { agent, csrf } = await signIn(h, "manager");
  const text = Array.from({ length: 45 }, (_, i) => `شقة للبيع في ميفيدا ${100 + i} متر 3 غرف السعر ${10 + i} مليون`).join("\n\n\n");
  const r = await agent.post("/app/import/group").field("_csrf", csrf).field("range", "all").field("text", text);
  expect(r.status).toBe(303);
  expect(r.headers.location).toMatch(/\?cut=5$/);
  await Imports.waitForGroupImport(r.headers.location.split("/").pop().split("?")[0]);
  const page = await agent.get(r.headers.location);
  expect(page.text).toMatch(/data-cut-notice[^>]*>ℹ️ 5 بوست/);
});
