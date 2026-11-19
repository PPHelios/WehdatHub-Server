// tests/unit/chat-fingerprint.test.js — the chat and post ids the website and the app share (domain/chatFingerprint.js).
"use strict";

const F = require("../../domain/chatFingerprint");

// The app's own formulas (zipImport scanChat and whatsappImportMemory), kept here so a change on one side breaks this test.
const fnv = (s, seed) => { let h = seed >>> 0; for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; };
const appChat = (key) => fnv(key, 0x811c9dc5).toString(16).padStart(8, "0") + fnv(key, 0x1b873593).toString(16).padStart(8, "0");

test("chatFingerprint: 16 hex, equals the app's, ignores folder and letter case, changes with the first header", () => {
  const fp = F.chatFingerprint("WhatsApp Chat with Brokers.txt", "24/10/2026 10:15");
  expect(fp).toMatch(/^[0-9a-f]{16}$/);
  expect(fp).toBe(appChat("whatsapp chat with brokers.txt|24/10/2026 10:15"));
  expect(F.chatFingerprint("export/WHATSAPP CHAT WITH BROKERS.TXT", "24/10/2026 10:15")).toBe(fp);
  expect(F.chatFingerprint("WhatsApp Chat with Brokers.txt", "25/10/2026 10:15")).not.toBe(fp);
  expect(F.isChatFp(fp)).toBe(true);
});

test("firstHeaderOf reads the first message header, Android, iPhone and Arabic digits", () => {
  expect(F.firstHeaderOf("24/10/2026, 10:15 - Ali: hello\n24/10/2026, 10:16 - Sara: hi")).toBe("24/10/2026 10:15");
  expect(F.firstHeaderOf("noise\n[٢٤/١٠/٢٠٢٦, 10:15:32] Ali: hello")).toBe("24/10/2026 10:15");
  expect(F.firstHeaderOf("no header here")).toBe("");
});

test("postFingerprint: deterministic, ignores case, spacing and Arabic spelling variants, changes with sender, time or wording", () => {
  const a = F.postFingerprint("Ali", "24/10/2026 10:15", "شقة للبيع في التجمع");
  expect(a).toMatch(/^[0-9a-z]+$/);
  expect(F.postFingerprint("Ali", "24/10/2026 10:15", "شقه  للبيع في التجمع")).toBe(a);
  expect(F.postFingerprint(" ali ", "24/10/2026 10:15", "شقة للبيع في التجمع")).toBe(a);
  expect(F.postFingerprint("Sara", "24/10/2026 10:15", "شقة للبيع في التجمع")).not.toBe(a);
  expect(F.postFingerprint("Ali", "24/10/2026 10:16", "شقة للبيع في التجمع")).not.toBe(a);
  expect(F.postFingerprint("Ali", "24/10/2026 10:15", "شقة للبيع في الرحاب")).not.toBe(a);
  expect(F.postFingerprint(null, 1761300900000, "x")).toBe(F.postFingerprint("", "1761300900000", "x"));
  expect(F.isPostFp(a)).toBe(true);
});

test("postFingerprint equals the app's formula", () => {
  const norm = (t) => String(t ?? "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/[ً-ٟـ]/g, "").toLowerCase().replace(/[‎‏‪-‮]/g, "").replace(/\s+/g, " ").trim();
  const s = `${norm("Ali")}|${norm("24/10/2026 10:15")}|${norm("Villa for sale 5 million")}`;
  expect(F.postFingerprint("Ali", "24/10/2026 10:15", "Villa for sale 5 million")).toBe(fnv(s, 2166136261).toString(36) + fnv(s, 0x9747b28c).toString(36));
});

describe("the import date range (domain/chatParse.js rangeBounds), the same options the app offers", () => {
  const P = require("../../domain/chatParse");
  const now = new Date("2026-11-19T12:00:00Z");
  test("7 / 30 / 90 days, all, the default, since the last import, custom since and inclusive until", () => {
    expect(P.rangeBounds("7", { now })).toEqual({ since: "2026-11-12", until: null });
    expect(P.rangeBounds("30", { now })).toEqual({ since: "2026-10-20", until: null });
    expect(P.rangeBounds("90", { now })).toEqual({ since: "2026-08-21", until: null });
    expect(P.rangeBounds("all", { now })).toEqual({ since: null, until: null });
    expect(P.rangeBounds("", { now })).toEqual({ since: "2026-10-20", until: null });
    expect(P.rangeBounds("last", { now, lastImportAt: "2026-11-10T09:00:00Z" })).toEqual({ since: "2026-11-09", until: null });
    expect(P.rangeBounds("last", { now })).toEqual({ since: "2026-10-20", until: null });
    expect(P.rangeBounds("custom", { now, since: "2026-11-01", until: "2026-11-05" })).toEqual({ since: "2026-11-01", until: "2026-11-06" });
    expect(P.rangeBounds("custom", { now, since: "junk" })).toEqual({ since: null, until: null });
  });
  test("the bounds feed the chat reader: posts outside the range are dropped", () => {
    const Chat = require("../../domain/chatExport");
    const line = (d, n) => `${d}, 10:00 - Ali: Villa for sale ${n} 300m 4 bedrooms price 9 million 01012345678`;
    const text = [line("01/11/2026", 1), line("05/11/2026", 2), line("09/11/2026", 3)].join("\n");
    const r = P.rangeBounds("custom", { since: "2026-11-03", until: "2026-11-05" });
    expect(Chat.candidatePosts(text, r).posts.map((p) => p.text.match(/sale (\d)/)[1])).toEqual(["2"]);
  });
});
