// domain/analyticsPrivacy.js — Privacy rules for the market analytics (pure). A market cell is written only when enough
// different agencies and rows stand behind it; otherwise it is left out (its data still counts in a wider cell that passes).
// Nothing personal ever enters an aggregate: FORBIDDEN names the fields that must never appear, and assertClean() checks an
// object (keys and values) before it is written or shown.
"use strict";

const MIN_AGENCIES = 5; // k: at least this many different agencies in a market cell
const MIN_ROWS = 10; // and at least this many units (or leads) behind it
const MIN_LEADS_PER_AGENCY = 3; // an agency counts in the market funnel median only with this many leads that month
const MIN_SEARCHES = 10; // demand cells below this many searches are shown as "not enough data"

// Field names that must never be in an analytics table, CSV or page.
const FORBIDDEN = ["phone", "phones", "phone_e164", "client_phone", "name", "client_name", "owner", "owner_id", "notes", "note", "unit_code", "code", "raw_text", "query_text", "broker_id", "address", "photos", "email", "result_ids"];

/** True when a cell is big enough to be written. cell: { agencies_n, rows_n }. */
function passes(cell) {
  return Boolean(cell) && Number(cell.agencies_n) >= MIN_AGENCIES && Number(cell.rows_n) >= MIN_ROWS;
}

/** The cell, or null when it is too small to be written as detail. */
function suppress(cell) {
  return passes(cell) ? cell : null;
}

/** Cells that pass, in their given order (the roll-up levels are tried by the caller, finest first). */
function keepPassing(cells) {
  return (cells || []).filter(passes);
}

const SAFE_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}(?:[T ].*)?)$/i;
const PHONE_LIKE = /(?:\+?20|0)?1[0125]\d{8}\b|\+?\d[\d\s-]{9,}\d/;

/** Every problem in a value: a forbidden key, or a text that looks like a phone number. → string[] (empty when clean). */
function problems(value, path = "") {
  const out = [];
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => out.push(...problems(v, `${path}[${i}]`)));
    return out;
  }
  if (typeof value === "object") {
    if (value instanceof Date) return out;
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN.includes(k.toLowerCase())) out.push(`${path}.${k}`);
      out.push(...problems(v, `${path}.${k}`));
    }
    return out;
  }
  if (typeof value === "string" && !SAFE_ID.test(value) && PHONE_LIKE.test(value)) out.push(`${path}=phone-like`);
  return out;
}

/** Throws when the value holds a forbidden field or a phone-like text. */
function assertClean(value) {
  const p = problems(value);
  if (p.length) throw new Error(`analytics privacy: ${p.slice(0, 3).join(", ")}`);
  return value;
}

module.exports = { MIN_AGENCIES, MIN_ROWS, MIN_LEADS_PER_AGENCY, MIN_SEARCHES, FORBIDDEN, passes, suppress, keepPassing, problems, assertClean };
