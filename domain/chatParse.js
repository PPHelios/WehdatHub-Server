// domain/chatParse.js — The pure part of reading a WhatsApp chat export: lines → messages with times and photo files,
// and "does this text describe a unit". It has no requires, so the same file runs on the server and in the browser
// (web/assets.js serves it as /app/static/chatparse.js and the match page loads it).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ChatParse = factory();
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

const BIDI = /[‎‏‪-‮⁦-⁩]/g;
const AR = "٠١٢٣٤٥٦٧٨٩";
const latin = (s) => String(s).replace(/[٠-٩]/g, (d) => String(AR.indexOf(d)));

// [24/10/2026, 10:15:32] Name: text   (iOS)
const IOS = /^\[(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[APap]\.?[Mm]\.?|\s*[صم])?)\]\s*([^:]{1,80}?):\s?([\s\S]*)$/;
// 24/10/2026, 10:15 - Name: text   (Android; "ص"/"م" or AM/PM)
const ANDROID = /^(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?:\s*[APap]\.?[Mm]\.?|\s*[صم])?)\s+-\s+([^:]{1,80}?):\s?([\s\S]*)$/;
const HEAD = /^\[?\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4},?\s+\d{1,2}:\d{2}/;
// A photo in an export with media: "IMG-20261024-WA0001.jpg (file attached)" (Android, Arabic "(ملف مرفق)") or
// "<attached: 00000012-PHOTO-2026-10-24-10-15-32.jpg>" (iOS, Arabic "<مرفق: …>"). HEIC/HEIF are read too (the browser converts them to JPEG before upload).
const ATTACHED = /^(?:<(?:attached|مرفق)\s*:\s*([^>]+?\.(?:jpe?g|png|webp|heic|heif))\s*>|([^\s<>]+?\.(?:jpe?g|png|webp|heic|heif))\s*\((?:file attached|ملف مرفق)\))\s*$/i;
const PHOTO_WINDOW_MS = 10 * 60 * 1000;
const MAX_PHOTOS = 15;
// A line of only separator marks (---, ***, ➖➖➖, 🔻🔻🔻, ===): a guaranteed boundary between two units.
const DIVIDER = /^(?:[-\u2013\u2014_=*~#\u2022\u00b7\u2550\u2500\u2501\u25ac\u2796\u{1F53B}\u{1F53A}\u{1F538}\u{1F539}\u25aa\u25ab\u25fe\u25fd\u27b0\u3030]\uFE0F?\s*){3,}$/u;
// "photos above/below" written by the broker: arrows or words (Arabic, English).
const CUE_UP = /(?:\u2b06|\u261d|\u{1F446})\uFE0F?|(?:\u0635\u0648\u0631\u0647?\u0629?|\u0627\u0644\u0635\u0648\u0631|photos?|pics?)\s*(?:\u0641\u0648\u0642|above)/iu;
const CUE_DOWN = /(?:\u2b07|\u{1F447})\uFE0F?|(?:\u0635\u0648\u0631\u0647?\u0629?|\u0627\u0644\u0635\u0648\u0631|photos?|pics?)\s*(?:\u062a\u062d\u062a|below)/iu;
/** Direction cues in a description: { up: its photos are above it, down: its photos are below it }. */
const cuesOf = (text) => ({ up: CUE_UP.test(String(text || "")), down: CUE_DOWN.test(String(text || "")) });
const SKIP = /^(<media omitted>|<الوسائط محذوفة>|image omitted|video omitted|sticker omitted|this message was deleted|تم حذف هذه الرسالة|null)$/i;

/** "24/10/2026 10:15:32 PM" (day first, as Egyptian phones write it) → a comparable number of ms, or null. */
function atMs(at) {
  const m = String(at || "").match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([APap]\.?[Mm]\.?|[صم])?/);
  if (!m) return null;
  const [, d, mo, y, hh, mm, ss] = m;
  const ampm = (m[7] || "").toLowerCase().replace(/\./g, "");
  let hour = Number(hh);
  if ((ampm === "pm" || ampm === "م") && hour < 12) hour += 12;
  if ((ampm === "am" || ampm === "ص") && hour === 12) hour = 0;
  const year = Number(y) < 100 ? 2000 + Number(y) : Number(y);
  return Date.UTC(year, Number(mo) - 1, Number(d), hour, Number(mm), Number(ss || 0));
}

/** "2026-07-30" (a date input) → ms at the start of that day, or null; and the default "last 30 days" start. */
const sinceMs = (v) => {
  const m = String(v || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};
const DEFAULT_DAYS = 30;
const defaultSince = (now = new Date()) => new Date(now.getTime() - DEFAULT_DAYS * 86400000).toISOString().slice(0, 10);
/** Messages older than since are dropped; a message whose time can't be read is kept. */
const notOlder = (since) => (m) => {
  const t = atMs(m.at);
  return since === null || t === null || t >= since;
};

/**
 * A chat export with media → messages [{ sender, at, text, files, i }]: a photo line becomes a file of its message
 * (Android puts a caption under it), other media lines are dropped.
 */
function parseWithAttachments(text) {
  const out = [];
  for (const raw of String(text || "").replace(BIDI, "").split(/\r?\n/)) {
    const line = latin(raw).trimEnd();
    const m = line.trim().match(IOS) || line.trim().match(ANDROID);
    if (m) {
      const first = m[4].trim();
      const file = first.match(ATTACHED);
      if (DIVIDER.test(first)) out.push({ sender: m[3].trim(), at: `${m[1]} ${m[2]}`.trim(), text: "", files: [], divider: true });
      else out.push({ sender: m[3].trim(), at: `${m[1]} ${m[2]}`.trim(), text: file ? "" : first, files: file ? [(file[1] || file[2]).trim()] : [] });
    } else if (HEAD.test(line.trim())) {
      out.push({ sender: null, at: null, text: "", files: [], system: true });
    } else if (out.length && line.trim()) {
      let last = out[out.length - 1];
      if (DIVIDER.test(line.trim())) {
        // A separator line inside a message (a forward's own divider): a boundary, then the rest is a new part of that message.
        if (!last.divider) out.push({ sender: last.sender, at: last.at, text: "", files: [], divider: true });
        continue;
      }
      if (last.divider) {
        out.push({ sender: last.sender, at: last.at, text: line.trim(), files: [] });
        continue;
      }
      last.text = last.text ? `${last.text}\n${line.trim()}` : line.trim();
    }
  }
  return out.filter((m) => !m.system && (m.divider || m.files.length || (m.text && !SKIP.test(m.text.trim())))).map((m, i) => ({ ...m, i }));
}

const PRICE = /(\d[\d.,]*\s*(?:مليون|ألف|الف|million|k\b|m\b|ج|جنيه|egp))|(?:السعر|سعر|price|مقدم|المقدم|down payment|اجمالي|إجمالي)/i;
const UNIT = /(\d+\s*(?:م|متر|م2|م²|sqm|m2|m²)\b)|(?:غرف|غرفة|غرفه|bedroom|beds?|شقة|شقه|فيلا|تاون|توين|دوبلكس|استوديو|بنتهاوس|شاليه|apartment|villa|duplex|studio|chalet|مساحة|مساحه|area)/i;
const REQUEST = /(?:^|\s)(مطلوب|عايز|عاوز|محتاج|ابحث|looking for|wanted|required)(?=\s|$)/i;

/** A post that describes a unit for sale or rent (not a request, not chatter). */
function looksLikeListing(text) {
  const t = latin(String(text || ""));
  if (t.length < 30 || REQUEST.test(t)) return false;
  return PRICE.test(t) && UNIT.test(t);
}


return { BIDI, latin, IOS, ANDROID, HEAD, SKIP, DIVIDER, cuesOf, PHOTO_WINDOW_MS, MAX_PHOTOS, DEFAULT_DAYS, atMs, sinceMs, defaultSince, notOlder, parseWithAttachments, looksLikeListing };
});
