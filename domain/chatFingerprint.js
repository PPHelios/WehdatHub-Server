// domain/chatFingerprint.js — Stable ids for a WhatsApp chat and for each of its posts (pure, deterministic, no requires), so
// the website and the app remember what a person decided about a post (saved, discarded, unchanged) and a later import of the
// same chat, or of a longer export of it, does not ask again. The same file runs on the server and in the browser
// (web/assets.js serves it as /app/static/chatfingerprint.js) and is copied into the app (scripts/sync-chat-domain.mjs), so
// every client hashes identically. The hashes equal the ones the app already computed (zipImport scanChat, whatsappImportMemory).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ChatFingerprint = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const BIDI = /[‎‏‪-‮⁦-⁩]/g;
  const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
  const latin = (s) => String(s).replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));
  // A message line: "24/10/2026, 10:15 - Name: text" (Android) or "[24/10/2026, 10:15:32] Name: text" (iPhone). Day first.
  const MSG = /^\[?(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([APap]\.?[Mm]\.?|[صم])?\]?\s*(?:-\s+)?[^:]{1,80}?:/;

  // Two 32-bit FNV-1a passes with different seeds: small, deterministic, no dependency.
  function fnv(text, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  /** Arabic spelling variants are one letter for the comparison: أإآ to ا, ة to ه, ى to ي (marks and the tatweel are dropped). */
  const foldArabic = (t) => String(t).replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/[ً-ٟـ]/g, "");
  const norm = (t) => foldArabic(String(t === null || t === undefined ? "" : t)).toLowerCase().replace(/[‎‏‪-‮]/g, "").replace(/\s+/g, " ").trim();
  const baseName = (p) => String(p || "").split("/").pop() || String(p || "");

  /**
   * A stable id of a post: the same sender, time and wording give the same id on every import (spelling variants, Arabic or Latin
   * letter case and spacing do not matter).
   * @param {string|null} sender the message's sender
   * @param {string|number|null} at the chat's own time text ("24/10/2026 10:15", what the readers return as `at`), or epoch ms
   * @param {string} text the message exactly as written (use the original when you have it)
   * @returns {string} base-36, about 12 characters
   */
  function postFingerprint(sender, at, text) {
    const s = `${norm(sender)}|${norm(at)}|${norm(text)}`;
    return fnv(s, 2166136261).toString(36) + fnv(s, 0x9747b28c).toString(36);
  }

  /**
   * A stable id of a chat: its file name (folder and letter case ignored) and the header of its first message, so a longer
   * export of the same chat keeps the id.
   * @param {string} chatFileName the chat text's name in the zip ("WhatsApp Chat with X.txt")
   * @param {string} firstHeader "d/m/yyyy h:mm" of the first message (see firstHeaderOf)
   * @returns {string} 16 lower-case hex characters
   */
  function chatFingerprint(chatFileName, firstHeader) {
    const key = `${baseName(chatFileName).toLowerCase()}|${firstHeader || ""}`;
    const hex = (n) => n.toString(16).padStart(8, "0");
    return hex(fnv(key, 0x811c9dc5)) + hex(fnv(key, 0x1b873593));
  }

  /** The first message's header of a chat text ("24/10/2026 10:15", day first, as written), or "" when it has none. */
  function firstHeaderOf(text) {
    for (const raw of String(text || "").split(/\r?\n/)) {
      if (raw.length < 8) continue;
      const m = latin(raw.replace(BIDI, "")).trim().match(MSG);
      if (m) return `${m[1]}/${m[2]}/${m[3]} ${m[4]}:${m[5]}`;
    }
    return "";
  }

  const isChatFp = (v) => /^[0-9a-f]{16}$/.test(String(v || ""));
  const isPostFp = (v) => /^[0-9a-z]{2,24}$/.test(String(v || ""));

  return { postFingerprint, chatFingerprint, firstHeaderOf, isChatFp, isPostFp, foldArabic };
});
