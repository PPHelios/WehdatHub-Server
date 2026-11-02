// tests/unit/ai-switches.test.js — the owner's AI feature switches and the shared out-of-credit wording
"use strict";

const Switches = require("../../services/aiSwitches");
const AiBlock = require("../../lib/aiBlock");

test("everything is on by default; a tab master switch turns off its features", () => {
  expect(Switches.allowed({}, "ask")).toBe(true);
  expect(Switches.allowed({ ai_switches: { tabs: { written: false } } }, "ask")).toBe(false);
  expect(Switches.allowed({ ai_switches: { tabs: { written: false } } }, "voice_search")).toBe(true);
  expect(Switches.allowed({ ai_switches: { features: { ask: false } } }, "ask")).toBe(false);
  expect(Switches.allowed({ ai_photo_order: false }, "photo_order")).toBe(false);
});

test("a feature is found from its route; voice variants and the caller's own feature win", () => {
  expect(Switches.featureFor("assistant")).toBe("ask");
  expect(Switches.featureFor("listing_extraction")).toBe("unit_fill");
  expect(Switches.featureFor("listing_extraction", { audio: true })).toBe("voice_unit_add");
  expect(Switches.featureFor("search_parse", { feature: "voice_search" })).toBe("voice_search");
});

test("assertOn throws AI_OFF for a switched-off feature and spends nothing", async () => {
  const db = { query: async () => ({ rows: [{ crm_settings: { ai_switches: { features: { ask: false } } } }] }) };
  Switches.clearCache();
  await expect(Switches.assertOn(db, "a1", "ask")).rejects.toMatchObject({ code: "AI_OFF" });
  await expect(Switches.assertOn(db, "a1", "follow_up")).resolves.toBeUndefined();
});

test("only the agency owner saves the switches", async () => {
  const calls = [];
  const db = { query: async (...a) => calls.push(a) };
  expect(await Switches.save(db, { role: "manager", agency_id: "a" }, {})).toEqual({ error: "forbidden" });
  expect(await Switches.save(db, { role: "owner", agency_id: "a" }, { tab_voice: "on", f_ask: "on" })).toEqual({ ok: true });
  const saved = JSON.parse(calls[0][1][1]);
  expect(saved.tabs.voice).toBe(true);
  expect(saved.tabs.search).toBe(false);
  expect(saved.features.ask).toBe(true);
  expect(saved.features.photo_order).toBe(false);
});

test("out-of-credit wording sends only the owner to buy credits", () => {
  const err = Object.assign(new Error("x"), { code: "PLAN_QUOTA_EXCEEDED" });
  expect(AiBlock.kindOf(err)).toBe("quota");
  expect(AiBlock.kindOf(Object.assign(new Error("x"), { code: "AI_OFF" }))).toBe("off");
  expect(AiBlock.text("quota", "en", { owner: false })).toMatch(/owner/i);
});
