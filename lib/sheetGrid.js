// lib/sheetGrid.js — Turns the tabs of a workbook (grids of cells, read in the browser or from a file) into the mapped rows
// the import plans: every tab is read, the header row is found (or the columns are recognised by what they hold),
// the compound comes from the tab name and rent or sale from the file or tab name when the sheet does not say.
"use strict";

const SheetImport = require("../domain/sheetImport");
const { normalizeSearch } = require("../domain/searchText");

const MAX_TOTAL_ROWS = 5000;
const MAX_TABS = 60;
const MAX_COLS = 80;
const HEADER_SCAN = 10;
const SAMPLE = 200;

const fail = (code, message) => Object.assign(new Error(message), { code });
const blank = (v) => v === null || v === undefined || String(v).trim() === "";
const text = (v) => String(v ?? "").trim();

/** Tab names that are not a place ("Sheet1", "data"). */
const GENERIC_TAB = /^(sheet|table|tab|data|inventory|units?|rent|sale|ورقه|ورقة|المخزون)\s*\d*$/i;

// Cell values that say "no compound" (outside any compound, not applicable).
const NOT_A_COMPOUND = /^(?:outside(?:\s+compound)?|not\s+a\s+compound|no\s+compound|none|n\/?a|-+|مش\s*كمبوند|خارج\s*(?:الكمبوند)?|بره\s*الكمبوند)$/i;

/** rent | sale from a file or tab name ("RENT - All compounds", "للبيع"); null when it says neither or both. */
function typeFromName(name) {
  const t = normalizeSearch(name);
  const rent = /(\brent\b|\brental|for rent|ايجار|للايجار)/.test(t);
  const sale = /(\bsale\b|\bbuy\b|\bresale\b|for sale|للبيع|\bبيع\b)/.test(t);
  return rent && !sale ? "rent" : sale && !rent ? "sale" : null;
}

const CODE_PARTS = /^([A-Za-z]{1,6})([-_ ]?)(\d{1,6})$/;

/**
 * The pattern a tab's own codes follow ("NH-9", "VR12"): the letters most codes start with, the separator, the width of
 * the numbers and the highest number. Null when fewer than three coded rows or no clear majority share one prefix.
 */
function codePattern(codes) {
  const parts = codes.map((c) => CODE_PARTS.exec(String(c).trim())).filter(Boolean);
  if (parts.length < 3) return null;
  const count = new Map();
  for (const p of parts) count.set(p[1].toUpperCase(), (count.get(p[1].toUpperCase()) || 0) + 1);
  const [prefix, n] = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
  if (n < 3 || n / codes.length < 0.7) return null;
  const mine = parts.filter((p) => p[1].toUpperCase() === prefix);
  const sep = [...new Set(mine.map((p) => p[2]))].length === 1 ? mine[0][2] : "";
  const padded = mine.some((p) => p[3].length > 1 && p[3].startsWith("0"));
  return { prefix, sep, width: padded ? Math.max(...mine.map((p) => p[3].length)) : 0, max: Math.max(...mine.map((p) => Number(p[3]))), count: n };
}

/** The header row among the top rows: { at, map: column → key } with at least three known columns. */
function findHeader(rows) {
  for (let i = 0; i < Math.min(HEADER_SCAN, rows.length); i++) {
    const map = {};
    rows[i].values.forEach((v, col) => {
      const key = blank(v) ? null : SheetImport.columnFor(String(v));
      if (key && !Object.values(map).includes(key)) map[col] = key;
    });
    if (Object.keys(map).length >= 3) return { at: i, map };
  }
  return null;
}

const PHONE = /^\+?\d{9,13}$/;
const CODE = /^[A-Za-z]{1,6}[-_ ]?\d{1,6}[A-Za-z]?$/;
const PRICE = /^\d[\d,.]*\s*(k|m|mn|ألف|الف|مليون|million|thousand)?\b/i;
const AREA = /^\d{2,5}(?:\.\d+)?\s*(m2|m²|sqm|m|م|متر)\b/i;
const RENT_SALE = /(rent|sale|ايجار|بيع|للبيع|للايجار)/i;

/** What a column holds: the share of its values that look like each kind of cell. */
function profile(values) {
  const v = values.filter((x) => !blank(x)).slice(0, SAMPLE);
  const n = v.length;
  if (!n) return null;
  const share = (fn) => v.filter(fn).length / n;
  const s = (x) => text(x);
  return {
    n,
    phone: share((x) => PHONE.test(s(x).replace(/[\s-]/g, "").split(/[/\\,;]/)[0])),
    code: share((x) => CODE.test(s(x))),
    type: share((x) => Boolean(SheetImport.propertyType(s(x)))),
    listing: share((x) => RENT_SALE.test(s(x)) && s(x).length < 20),
    area: share((x) => (typeof x === "number" ? x >= 30 && x <= 5000 : AREA.test(s(x)))),
    price: share((x) => (typeof x === "number" ? x >= 1000 : SheetImport.money(x) >= 1000 || /^\d[\d,.]*\s*k\b/i.test(s(x)))),
    rooms: share((x) => (typeof x === "number" ? Number.isInteger(x) && x >= 0 && x <= 9 : /^\d$/.test(s(x)))),
    long: share((x) => s(x).length > 40),
    nameish: share((x) => /^[A-Za-z؀-ۿ][A-Za-z؀-ۿ .'/-]{2,40}$/.test(s(x)))
  };
}

// Strongest, most specific kinds first; a column is given to the first kind it clearly is.
const KINDS = [
  ["owner_phone", "phone", 0.7],
  ["code", "code", 0.7],
  ["property_type", "type", 0.6],
  ["listing_type", "listing", 0.6],
  ["area_value", "area", 0.6],
  ["price_value", "price", 0.6],
  ["bedrooms", "rooms", 0.7],
  ["description", "long", 0.5],
  ["owner_name", "nameish", 0.8]
];

/** Columns recognised by their content: { column → key }, only for columns not already named by a header. */
function alignByContent(rows, columns, taken) {
  const map = {};
  const used = new Set(taken);
  const profiles = columns.map((col) => ({ col, p: profile(rows.map((r) => r.values[col])) })).filter((x) => x.p && x.p.n >= 2);
  for (const [key, kind, min] of KINDS) {
    if (used.has(key)) continue;
    const best = profiles.filter((x) => !(x.col in map) && x.p[kind] >= min).sort((a, b) => b.p[kind] - a.p[kind] || a.col - b.col)[0];
    if (best) {
      map[best.col] = key;
      used.add(key);
    }
  }
  return map;
}

const FIT = { owner_phone: "phone", code: "code", property_type: "type", area_value: "area", price_value: "price", listing_type: "listing" };

/**
 * Headers that sit over the wrong columns (a header row missing an empty column shifts every name after it): when the
 * columns the headers name do not hold what they should, try moving the names from the first bad one by 1 or 2 columns
 * and keep the layout that fits the content best.
 */
function repairHeaders(rows, map) {
  const data = rows;
  const width = Math.max(...rows.map((r) => r.values.length));
  const cache = new Map();
  const prof = (c) => {
    if (c < 1 || c >= width) return null;
    if (!cache.has(c)) cache.set(c, profile(data.map((r) => r.values[c])));
    return cache.get(c);
  };
  const score = (m) => Object.entries(m).reduce((sum, [col, key]) => (FIT[key] ? sum + (prof(Number(col))?.[FIT[key]] || 0) : sum), 0);
  let current = map;
  for (let pass = 0; pass < 2; pass++) {
    const bad = Object.keys(current).map(Number).sort((a, b) => a - b).find((c) => FIT[current[c]] && (prof(c)?.[FIT[current[c]]] || 0) < 0.25);
    if (bad === undefined) break;
    let best = { score: score(current), map: current };
    for (const shift of [1, -1, 2, -2]) {
      const moved = {};
      for (const [col, key] of Object.entries(current)) moved[Number(col) >= bad ? Number(col) + shift : Number(col)] = key;
      if (Object.keys(moved).length !== Object.keys(current).length || Object.keys(moved).some((c) => Number(c) < 1 || Number(c) >= width)) continue;
      const sc = score(moved);
      if (sc > best.score + 0.8) best = { score: sc, map: moved };
    }
    if (best.map === current) break;
    current = best.map;
  }
  return current;
}

/**
 * One tab → { rows, skipped, info }. Headers are used when the tab has them; otherwise (and for columns whose header
 * is empty) the columns are recognised by their content.
 */
function readTab(tab, { fileType }) {
  const rows = tab.rows.map((r) => ({ rowNumber: r.n, values: [null, ...r.v.slice(0, MAX_COLS)] }));
  const info = { name: tab.name, mode: "none", rows: 0, mapped: [], ignored: [] };
  if (!rows.length) return { rows: [], skipped: [], info: { ...info, reason: "empty" } };

  let header = findHeader(rows);
  let map = header ? { ...header.map } : {};
  // The sheet's own header words, kept so a file of the rows that did not import can use them.
  info.headers = header ? Object.fromEntries(Object.entries(header.map).map(([col, key]) => [key, text(rows[header.at].values[col]).slice(0, 60)])) : {};
  if (header) {
    const body = rows.slice(header.at + 1);
    const fixed = body.length >= 3 ? repairHeaders(body, map) : map;
    if (fixed !== map) {
      map = fixed;
      info.shifted = true;
    }
  }
  let dataFrom = header ? header.at + 1 : 0;
  const width = Math.max(...rows.map((r) => r.values.length));
  const headerless = [];
  for (let c = 1; c < width; c++) {
    if (c in map) continue;
    const h = header ? rows[header.at].values[c] : null;
    if (blank(h)) headerless.push(c);
    else info.ignored.push(text(h));
  }
  const aligned = alignByContent(rows.slice(dataFrom), header ? headerless : headerless, Object.values(map));
  if (Object.keys(aligned).length) {
    Object.assign(map, aligned);
    info.mode = header ? "headers+content" : "content";
  } else info.mode = header ? "headers" : "none";
  if (!header && Object.keys(map).length < 2) return { rows: [], skipped: [], info: { ...info, mode: "none", reason: "no_columns" } };
  if (!header) dataFrom = 0;

  info.mapped = Object.values(map);
  const tabType = typeFromName(tab.name) || fileType;
  const placeName = !GENERIC_TAB.test(text(tab.name)) ? text(tab.name) : null;
  const out = [];
  const skipped = [];
  for (const row of rows.slice(dataFrom)) {
    const cells = {};
    for (const [col, key] of Object.entries(map)) {
      const v = row.values[Number(col)];
      if (!blank(v)) cells[key] = typeof v === "string" ? v.trim() : v;
    }
    if (!Object.keys(cells).length) {
      if (row.values.some((v, i) => i > 0 && !blank(v))) skipped.push({ sheetRow: row.rowNumber, tab: tab.name });
      continue;
    }
    if (blank(cells.listing_type) && tabType) cells.listing_type = tabType;
    // The compound column can say "outside" or "not a compound": the compound is then read from the location column, then the tab name.
    if (!blank(cells.compound) && NOT_A_COMPOUND.test(text(cells.compound))) {
      delete cells.compound;
      const from = blank(cells.location) ? cells.address : cells.location;
      if (!blank(from) && !NOT_A_COMPOUND.test(text(from))) cells.compound = from;
    }
    if (blank(cells.compound) && placeName) cells.compound = placeName;
    out.push({ sheetRow: row.rowNumber, tab: tab.name, cells });
  }
  info.rows = out.length;
  info.code_pattern = codePattern(out.map((r) => r.cells.code).filter((c) => !blank(c)));
  info.compound_from_tab = Boolean(placeName) && !info.mapped.includes("compound");
  info.listing_type = tabType;
  return { rows: out, skipped, info };
}

/**
 * Tabs of grids → the sheet the import plans.
 * @param {{ name: string, rows: { n: number, v: any[] }[] }[]} tabs
 * @param {{ filename?: string }} opts
 * @returns {{ rows: { rowNumber, cells, tab, sheetRow }[], skipped: [], tabs: [], mapped: string[], defaults: { listing_type: string|null } }}
 * @throws {Error} code NO_TABS | NO_HEADER | TOO_MANY_ROWS
 */
function buildSheet(tabs, { filename = "" } = {}) {
  if (!Array.isArray(tabs) || !tabs.length) throw fail("NO_TABS", "The workbook has no tab with data");
  if (tabs.length > MAX_TABS) throw fail("TOO_MANY_TABS", `More than ${MAX_TABS} tabs`);
  const fileType = typeFromName(String(filename).replace(/\.[a-z0-9]+$/i, ""));
  const rows = [];
  const skipped = [];
  const infos = [];
  let seq = 0;
  for (const tab of tabs) {
    const r = readTab({ name: text(tab.name).slice(0, 80), rows: Array.isArray(tab.rows) ? tab.rows : [] }, { fileType });
    infos.push(r.info);
    for (const x of r.rows) {
      if (++seq > MAX_TOTAL_ROWS) throw fail("TOO_MANY_ROWS", `More than ${MAX_TOTAL_ROWS} rows`);
      rows.push({ rowNumber: seq, ...x });
    }
    for (const x of r.skipped) skipped.push({ rowNumber: ++seq, ...x });
  }
  if (!rows.length) throw fail("NO_HEADER", "No header row with known columns (code, compound, price, area, …)");
  const mapped = [...new Set(infos.flatMap((i) => i.mapped))];
  const types = new Set(infos.filter((i) => i.rows).map((i) => i.listing_type || null));
  return { rows, skipped, tabs: infos, mapped, defaults: { listing_type: types.size === 1 ? [...types][0] : null, file_type: fileType } };
}

const codeParts = (code) => CODE_PARTS.exec(String(code).trim());

module.exports = { buildSheet, codePattern, codeParts, typeFromName, findHeader, alignByContent, profile, MAX_TOTAL_ROWS, MAX_TABS };
