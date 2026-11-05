// tests/web/guide.test.js — Phase 2 step 1: the quick guide and FAQ at /app/guide is open without signing in, in
// Arabic and English (?lang=), lists every section and the FAQ, and the bot's help reply links to it.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const Guide = require("../../web/routes/guide");

jest.setTimeout(90000);

let h;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

test("signed out: the guide opens in Arabic by default and in English with ?lang=en", async () => {
  const ar = await request(h.app.app).get("/app/guide");
  expect(ar.status).toBe(200);
  expect(ar.text).toContain('dir="rtl"');
  expect(ar.text).toContain("دليل سريع");
  const en = await request(h.app.app).get("/app/guide?lang=en");
  expect(en.status).toBe(200);
  expect(en.text).toContain("Quick guide");
  // Signed out sees the general sections; the app owner's own section shows only to them.
  for (const s of Guide.SECTIONS.filter((x) => x.who !== "crm")) expect(en.text).toContain(`id="${s.id}"`);
  expect(en.text).not.toContain('id="crm"');
  expect((en.text.match(/<details>/g) || []).length).toBe(Guide.FAQ.length);
});

test("the bot's help reply ends with the guide link", async () => {
  await h.text("broker", "مساعدة");
  const last = h.WA.outbox.filter((m) => m.type === "text").pop();
  expect(last.text).toMatch(/📘 الدليل السريع والأسئلة الشائعة: https?:\/\/\S+\/app\/guide$/);
  await h.text("admin", "help");
  expect(h.WA.outbox.filter((m) => m.type === "text").pop().text).toMatch(/Quick guide and FAQ: \S+\/app\/guide\?lang=en$/);
});

test("signed in, the guide shows each role only what it can use", async () => {
  const { signIn } = require("../harness/web");
  const broker = await signIn(h, "broker");
  const bk = (await broker.agent.get("/app/guide?lang=en")).text;
  expect(bk).toContain('id="clients"');
  expect(bk).not.toContain('id="managers"');
  const admin = await signIn(h, "admin");
  expect((await admin.agent.get("/app/guide?lang=en")).text).toContain('id="managers"');
  // Signed out sees the general sections plus the managers' one is hidden only for signed-in non-managers.
  expect((await request(h.app.app).get("/app/guide?lang=en")).text).toContain('id="start"');
});
