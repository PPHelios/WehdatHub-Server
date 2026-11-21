// tests/web/guide.test.js — Comprehensive verification of /app/guide
// Verifies all 5 tabs (Telegram, Units, Excel Import, WhatsApp Intake, Leads/CRM),
// bilingual rendering (Arabic & English), static asset resolution without broken links,
// role gates, and strict data sanitization against real Egyptian phone numbers and names.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const fs = require("fs");
const path = require("path");
const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const Guide = require("../../web/routes/guide");
const { loadAssets } = require("../../web/assets");

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

test("R1-R4: GET /app/guide returns HTTP 200 across all 5 tabs in Arabic and English", async () => {
  const tabs = [
    { key: "bot", arTerm: "أوامر البوت", enTerm: "Bot commands" },
    { key: "units", arTerm: "إضافة وحدة جديدة", enTerm: "How to Add a New Unit" },
    { key: "excel", arTerm: "رفع ملف الإكسيل", enTerm: "Excel Workbooks" },
    { key: "chat", arTerm: "أرشيف الشات", enTerm: "WhatsApp Export Archives" },
    { key: "leads", arTerm: "تسجيل العميل الجديد", enTerm: "New Lead Registration" }
  ];

  for (const { key, arTerm, enTerm } of tabs) {
    // Arabic
    const resAr = await request(h.app.app).get(`/app/guide?tab=${key}`);
    expect(resAr.status).toBe(200);
    expect(resAr.text).toContain('dir="rtl"');
    expect(resAr.text).toContain(arTerm);

    // English
    const resEn = await request(h.app.app).get(`/app/guide?tab=${key}&lang=en`);
    expect(resEn.status).toBe(200);
    expect(resEn.text).toContain(enTerm);
  }
});

test("R5: all static guide images resolve with HTTP 200 without broken links", async () => {
  const assets = loadAssets();
  const guideRes = await request(h.app.app).get("/app/guide?lang=en");
  expect(guideRes.status).toBe(200);

  // Extract all img src attributes
  const imgMatches = [...guideRes.text.matchAll(/<img[^>]+src="([^">]+)"/g)].map((m) => m[1]);
  expect(imgMatches.length).toBeGreaterThanOrEqual(16);

  // Expected 16 new visual screenshots
  const requiredImages = [
    "guide/import-excel-01-upload-sheets.png",
    "guide/import-excel-02-mapping-headers.png",
    "guide/import-excel-03-diff-preview.png",
    "guide/import-excel-04-rules-dedup.png",
    "guide/import-chat-01-upload-filters.png",
    "guide/import-chat-02-parse-extract.png",
    "guide/import-chat-03-photos-matching.png",
    "guide/import-chat-04-conflict-assign.png",
    "guide/lead-intake-01-create-normalize.png",
    "guide/lead-intake-02-duplicate-guard.png",
    "guide/lead-intake-03-undo-stack.png",
    "guide/lead-intake-04-team-lead-pod.png",
    "guide/lead-manager-01-pipeline-board.png",
    "guide/lead-manager-02-rules-schedule.png",
    "guide/lead-manager-03-broker-away.png",
    "guide/lead-manager-04-pdpl-governance.png"
  ];

  for (const rel of requiredImages) {
    expect(assets.files[rel]).toBeDefined();
    expect(assets.files[rel].body.length).toBeGreaterThan(1000);

    const assetUrl = assets.url(rel);
    const res = await request(h.app.app).get(assetUrl);
    expect(res.status).toBe(200);
    expect(res.header["content-type"]).toMatch(/image\/png/);
    expect(res.body.length).toBeGreaterThan(1000);
  }
});

test("R5: strict data sanitization audit verifies zero real phone numbers or customer names", async () => {
  const guideSource = fs.readFileSync(path.join(__dirname, "../../web/routes/guide.js"), "utf8");
  const enPage = (await request(h.app.app).get("/app/guide?lang=en")).text;
  const arPage = (await request(h.app.app).get("/app/guide")).text;
  const combined = guideSource + "\n" + enPage + "\n" + arPage;

  // 1. Check for real phone numbers from test datasets (RENT - All compounds.xlsx and WhatsApp Chat - ،.zip)
  const forbiddenNumbers = [
    "01069985171",
    "01200510075",
    "01111616455",
    "1111616455",
    "01223940431",
    "01005666779",
    "01140004505",
    "01001428588",
    "01026002778",
    "01123456780"
  ];
  for (const num of forbiddenNumbers) {
    expect(combined).not.toContain(num);
  }

  // 2. Check for real customer / broker names from sample datasets
  const forbiddenNames = [
    "Wafaa Tantawy",
    "Tantawy",
    "ayman",
    "Sherif Helmy",
    "Neveen",
    "Ghada El Sharkawy"
  ];
  for (const name of forbiddenNames) {
    expect(combined).not.toContain(name);
  }

  // 3. Regex assertion: any Egyptian mobile number found MUST be one of the permitted dummy numbers
  const permittedNumbers = new Set([
    "01012345678",
    "201012345678",
    "01000000101",
    "01000000102",
    "01000000103"
  ]);

  const phoneRegex = /(?:01|\+201|201)[0125]\d{8}/g;
  const matches = combined.match(phoneRegex) || [];
  for (const match of matches) {
    const raw = match.replace("+", "");
    expect(permittedNumbers.has(raw) || permittedNumbers.has("0" + raw.slice(2))).toBe(true);
  }
});
