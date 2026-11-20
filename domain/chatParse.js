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

const DATE = String.raw`\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}`;
const TIME = String.raw`\d{1,2}:\d{2}`;
const AMPM = String.raw`(?:\s*[APap]\.?[Mm]\.?|\s*[صم])?`;
// [24/10/2026, 10:15:32] Name: text   (iOS; "," or Arabic "،" between date and time; year-first and en-US M/D/YY too)
const IOS = new RegExp(String.raw`^\[(${DATE})[,،]?\s+(${TIME}(?::\d{2})?${AMPM})\]\s*([^:]{1,80}?):\s?([\s\S]*)$`);
// 24/10/2026, 10:15 - Name: text   (Android; "ص"/"م" or AM/PM)
const ANDROID = new RegExp(String.raw`^(${DATE})[,،]?\s+(${TIME}${AMPM})\s+-\s+([^:]{1,80}?):\s?([\s\S]*)$`);
// A line that starts like a header (iOS "[date, time]" or Android "date, time - "). One that merely starts with a date and has
// no sender is a continuation of the message above (parseWithAttachments), a system notice only when it has the " - " / "]" shape.
const HEAD = new RegExp(String.raw`^(?:\[${DATE}[,،]?\s+${TIME}(?::\d{2})?${AMPM}\]|${DATE}[,،]?\s+${TIME}(?::\d{2})?${AMPM}\s+-\s)`);
const EDITED = /\s*<(?:this message was edited|تم تعديل هذه الرسالة)>\s*$/i;
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

const AT = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})[,،]?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([APap]\.?[Mm]\.?|[صم])?/;

/**
 * "24/10/2026 10:15:32 PM" → a comparable number of ms (the clock as written, read as UTC), or null.
 * order: "dmy" (default, as Egyptian phones write it), "mdy" (en-US) or "ymd"; a year-first date is always ymd.
 */
function atMs(at, order = "dmy") {
  const m = latin(at || "").match(AT);
  if (!m) return null;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let y, mo, d;
  if (m[1].length === 4 || order === "ymd") [y, mo, d] = [a, b, c];
  else if (order === "mdy") [mo, d, y] = [a, b, c];
  else [d, mo, y] = [a, b, c];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ampm = (m[7] || "").toLowerCase().replace(/\./g, "");
  let hour = Number(m[4]);
  if ((ampm === "pm" || ampm === "م") && hour < 12) hour += 12;
  if ((ampm === "am" || ampm === "ص") && hour === 12) hour = 0;
  if (y < 100) y += 2000;
  return Date.UTC(y, mo - 1, d, hour, Number(m[5]), Number(m[6] || 0));
}

/** The date order of a whole file, decided once from all its header times: "ymd", "dmy" or "mdy" (default dmy). */
function detectDateOrder(ats) {
  const parts = [];
  for (const at of ats) {
    const m = latin(at || "").match(AT);
    if (m) parts.push({ at, a: Number(m[1]), b: Number(m[2]), four: m[1].length === 4 });
  }
  if (parts.some((p) => p.four)) return "ymd";
  if (parts.some((p) => p.a > 12)) return "dmy";
  if (parts.some((p) => p.b > 12)) return "mdy";
  const backwards = (order) => {
    let n = 0;
    let prev = null;
    for (const p of parts) {
      const t = atMs(p.at, order);
      if (t === null) continue;
      if (prev !== null && t < prev) n++;
      prev = t;
    }
    return n;
  };
  return backwards("mdy") < backwards("dmy") ? "mdy" : "dmy";
}

/** A start/end bound → ms or null: epoch ms (number), "2026-07-30" or "2026-07-30T14:30" (a space works too; Arabic digits too). */
const sinceMs = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = latin(String(v ?? "")).trim();
  if (/^\d{9,}$/.test(s)) return Number(s);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)) : null;
};
const untilMs = sinceMs;
const DEFAULT_DAYS = 30;
const defaultSince = (now = new Date()) => new Date(now.getTime() - DEFAULT_DAYS * 86400000).toISOString().slice(0, 10);
/**
 * The import date range the website and the app both offer: "last" (since the last import of this chat, from its remembered
 * decisions; a day earlier so nothing at the edge is missed: posts already decided are skipped anyway), "7" / "30" / "90" days,
 * "all", or "custom" (a since date and an inclusive until date). Anything else is the default 30 days.
 * @returns {{ since: string|null, until: string|null }} bounds for notOlder(sinceMs(since), sinceMs(until)); until is exclusive
 */
function rangeBounds(kind, { now = new Date(), lastImportAt = null, since = null, until = null } = {}) {
  const day = 86400000;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const k = String(kind || "");
  if (k === "all") return { since: null, until: null };
  if (k === "custom") {
    const u = untilMs(until);
    return { since: sinceMs(since) === null ? null : String(since).trim(), until: u === null ? null : iso(u + day) };
  }
  const last = k === "last" && lastImportAt ? Date.parse(lastImportAt) : NaN;
  if (Number.isFinite(last)) return { since: iso(last - day), until: null };
  const days = { 7: 7, 30: 30, 90: 90 }[k] || DEFAULT_DAYS;
  return { since: iso(now.getTime() - days * day), until: null };
}
/** Messages before since, or at/after until (exclusive), are dropped; a message whose time can't be read is kept. Bounds are ms or null. */
const notOlder = (since, until = null) => (m) => {
  const t = typeof m.t === "number" ? m.t : atMs(m.at);
  if (t === null || t === undefined) return true;
  return (since === null || since === undefined || t >= since) && (until === null || until === undefined || t < until);
};

/**
 * A chat export with media → messages [{ sender, at, text, files, i }]: a photo line becomes a file of its message
 * (Android puts a caption under it), other media lines are dropped.
 */
function parseWithAttachments(text) {
  const out = [];
  const rawLines = String(text || "").replace(BIDI, "").split(/\r?\n/);
  const heads = [];
  for (const r of rawLines) {
    const hm = latin(r).trim().match(IOS) || latin(r).trim().match(ANDROID);
    if (hm) heads.push(`${hm[1]} ${hm[2]}`);
  }
  const order = detectDateOrder(heads);
  for (const raw0 of rawLines) {
    const raw = raw0.replace(EDITED, "");
    const line = latin(raw).trimEnd();
    const m = line.trim().match(IOS) || line.trim().match(ANDROID);
    if (m) {
      const first = m[4].trim();
      const file = first.match(ATTACHED);
      // `orig`: the message as it was written (Arabic digits, spacing and blank lines kept); `text` is the cleaned copy the readers use.
      const rt = raw.trim();
      const rawFirst = rt.slice(rt.length - m[4].length).trim();
      if (DIVIDER.test(first)) out.push({ sender: m[3].trim(), at: `${m[1]} ${m[2]}`.trim(), t: atMs(`${m[1]} ${m[2]}`, order), text: "", orig: "", files: [], divider: true });
      else out.push({ sender: m[3].trim(), at: `${m[1]} ${m[2]}`.trim(), t: atMs(`${m[1]} ${m[2]}`, order), text: file ? "" : first, orig: file ? "" : rawFirst, files: file ? [(file[1] || file[2]).trim()] : [] });
    } else if (HEAD.test(line.trim())) {
      out.push({ sender: null, at: null, t: null, text: "", orig: "", files: [], system: true });
    } else if (out.length && !line.trim()) {
      // A blank line inside a message is kept in its original text (trailing ones are trimmed at the end).
      const last = out[out.length - 1];
      if (last.orig && !last.divider && !last.system) last.orig += "\n";
    } else if (out.length && line.trim()) {
      let last = out[out.length - 1];
      if (DIVIDER.test(line.trim())) {
        // A separator line inside a message (a forward's own divider): a boundary, then the rest is a new part of that message.
        if (!last.divider) out.push({ sender: last.sender, at: last.at, t: last.t, text: "", orig: "", files: [], divider: true });
        continue;
      }
      if (last.divider) {
        out.push({ sender: last.sender, at: last.at, t: last.t, text: line.trim(), orig: raw.trim(), files: [] });
        continue;
      }
      last.text = last.text ? `${last.text}\n${line.trim()}` : line.trim();
      last.orig = last.orig ? `${last.orig}\n${raw.trimEnd()}` : raw.trim();
    }
  }
  return out.filter((m) => !m.system && (m.divider || m.files.length || (m.text && !SKIP.test(m.text.trim())))).map((m, i) => ({ ...m, orig: String(m.orig || "").replace(/\s+$/, ""), i }));
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


return { BIDI, latin, IOS, ANDROID, HEAD, SKIP, DIVIDER, cuesOf, PHOTO_WINDOW_MS, MAX_PHOTOS, DEFAULT_DAYS, atMs, detectDateOrder, sinceMs, untilMs, defaultSince, rangeBounds, notOlder, parseWithAttachments, looksLikeListing };
});
