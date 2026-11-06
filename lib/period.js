// lib/period.js — Period tabs (Yesterday · 7 days · Month) and a pager, shared by the owner and manager review pages.
// Yesterday is the whole previous Cairo day; 7 days and Month are the last 7 / 30 days up to now. Each period also carries
// the one before it (same length), so a page can show the change.
"use strict";

const { html, raw } = require("../web/html");

const TZ = "Africa/Cairo";
const DAY = 24 * 3600 * 1000;
const KEYS = ["yesterday", "7d", "month"];
const LABELS = { yesterday: ["إمبارح", "Yesterday"], "7d": ["٧ أيام", "7 days"], month: ["الشهر", "Month"] };
const DEFAULT = "7d";

function cairoParts(d) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  return Object.fromEntries(f.formatToParts(d).map((x) => [x.type, Number(x.value)]));
}

/** The instant Cairo's day containing `at` began. */
function startOfCairoDay(at) {
  const o = cairoParts(at);
  const offset = Date.UTC(o.year, o.month - 1, o.day, o.hour % 24, o.minute, o.second) - Math.floor(at.getTime() / 1000) * 1000;
  return new Date(Date.UTC(o.year, o.month - 1, o.day) - offset);
}

/** → { key, from, to, prevFrom, prevTo } for a query value ("yesterday", "7d", "month"); anything else is the default. */
function parse(value, now = new Date()) {
  const key = KEYS.includes(value) ? value : DEFAULT;
  if (key === "yesterday") {
    const to = startOfCairoDay(now);
    const from = new Date(to.getTime() - DAY);
    return { key, from, to, prevFrom: new Date(from.getTime() - DAY), prevTo: from };
  }
  const span = (key === "7d" ? 7 : 30) * DAY;
  const to = new Date(now);
  const from = new Date(to.getTime() - span);
  return { key, from, to, prevFrom: new Date(from.getTime() - span), prevTo: from };
}

/** "+12%", "-3%", "new" or "—": how `now` changed against `before`. */
function change(now, before) {
  if (!before) return now ? "new" : "—";
  const p = Math.round(((now - before) / before) * 100);
  return `${p > 0 ? "+" : ""}${p}%`;
}

/** The query string for a page, keeping its other filters. */
function qs(params, over = {}) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, ...over })) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}

/** The Yesterday · 7 days · Month tabs. `params` are the page's current query values (period, page reset on change). */
function tabs(path, params, key, lang) {
  return html`<nav class="seg" data-period-tabs aria-label="${lang === "en" ? "Period" : "الفترة"}">${raw(
    KEYS.map((k) => `<a href="${path}${qs(params, { period: k, page: "" })}"${k === key ? ' aria-current="page"' : ""} data-period="${k}">${LABELS[k][lang === "en" ? 1 : 0]}</a>`).join("")
  )}</nav>`;
}

/** Page number and offset from a query value. */
function pageOf(value, size = 20) {
  const page = Math.max(1, Math.min(10000, Number.parseInt(value, 10) || 1));
  return { page, size, offset: (page - 1) * size };
}

/** Previous / next links with the page number; empty when there is one page. */
function pager(path, params, { page, size }, total, lang) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) return "";
  const link = (p, text) => `<a class="btn secondary" href="${path}${qs(params, { page: p })}">${text}</a>`;
  return html`<p class="row" data-pager>${raw(page > 1 ? link(page - 1, lang === "en" ? "‹ Previous" : "‹ السابق") : "")} <span class="muted">${page} / ${pages} · ${total}</span> ${raw(page < pages ? link(page + 1, lang === "en" ? "Next ›" : "التالي ›") : "")}</p>`;
}

module.exports = { KEYS, DEFAULT, parse, change, tabs, qs, pageOf, pager, startOfCairoDay };
