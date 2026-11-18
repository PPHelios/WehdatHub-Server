// domain/unitFilters.js — The units list's filters, one copy for the website (web/routes/units.js) and the app
// (api/units.js), so both offer the same choices and read them the same way (QA round 3, finding 90). Pure: it returns the
// SQL conditions with ? placeholders and their values; the caller numbers them after its own leading parameters.
"use strict";

const Deal = require("./dealType");
const { PROPERTY_TYPES } = require("./fieldRules");
const { FURNISHING_STATUSES, FINISHING_STATUSES } = require("./furnishingStatus");

const OLD_AFTER_DAYS = 21; // "Units to check" (services/today.js uses the same number)
const DAY = 24 * 3600 * 1000;
const oneOf = (v, list) => (list.includes(String(v || "")) ? String(v) : "");

/**
 * Reads the filter query: the values a page needs to keep in its links, all cleaned.
 * isOwner: only the agency owner may ask for private (VIP) units.
 */
function read(q = {}, { isOwner = false, status = "active" } = {}) {
  const staleDays = parseInt(q.staleDays, 10);
  const bedrooms = parseInt(q.bedrooms, 10);
  return {
    mine: q.mine === "1" || q.mine === true,
    old: (q.old === "1" || q.old === true) && status === "active",
    onlyPrivate: (q.private === "1" || q.private === true) && isOwner,
    staleDays: staleDays >= 1 && staleDays <= 3650 ? staleDays : 0,
    type: oneOf(q.type, PROPERTY_TYPES),
    furnishing: oneOf(q.furnishing, [...FURNISHING_STATUSES, "none"]),
    finishing: oneOf(q.finishing, [...FINISHING_STATUSES, "none"]),
    deal: Deal.clean(q.deal),
    pmin: String(q.pmin || "").slice(0, 20),
    pmax: String(q.pmax || "").slice(0, 20),
    bedrooms: bedrooms >= 0 && bedrooms <= 20 ? bedrooms : null,
    q: String(q.q || "").trim().slice(0, 40)
  };
}

/**
 * The conditions for read()'s filters → [{ sql, values }]. alias: the listings table's alias ("" for none). compound: the
 * exact compound name the caller resolved (or ""). now: for "units to check" and "not updated for N days".
 */
function conditions(f, { brokerId, alias = "", compound = "", now = new Date() } = {}) {
  const c = (name) => (alias ? `${alias}.${name}` : name);
  const out = [];
  const add = (sql, ...values) => out.push({ sql, values });
  if (f.mine) add(`${c("broker_id")} = ?`, brokerId);
  if (f.onlyPrivate) add(`${c("is_private")}`);
  if (f.old) {
    add(`${c("inventory_type")} IS DISTINCT FROM 'developer_model'`);
    add(`COALESCE(${c("confirmed_at")}, ${c("updated_at")}, ${c("created_at")}) < ?`, new Date(now.getTime() - OLD_AFTER_DAYS * DAY).toISOString());
  }
  if (f.staleDays) add(`COALESCE(${c("updated_at")}, ${c("created_at")}) < ?`, new Date(now.getTime() - f.staleDays * DAY).toISOString());
  if (compound) add(`${c("compound")} = ?`, compound);
  if (f.type) add(`${c("property_type")} = ?`, f.type);
  if (f.furnishing === "none") add(`${c("furnishing")} IS NULL`);
  else if (f.furnishing) add(`${c("furnishing")} = ?`, f.furnishing);
  if (f.finishing === "none") add(`${c("finishing")} IS NULL`);
  else if (f.finishing) add(`${c("finishing")} = ?`, f.finishing);
  if (f.deal) add(Deal.sql(f.deal, alias));
  const pmin = Deal.parseMoney(f.pmin);
  const pmax = Deal.parseMoney(f.pmax);
  if (pmin) add(`${c("price_value")} >= ?`, pmin);
  if (pmax) add(`${c("price_value")} <= ?`, pmax);
  if (f.bedrooms !== null && f.bedrooms !== undefined) add(`${c("bedrooms")} = ?`, f.bedrooms);
  if (f.q) {
    const like = f.q.replace(/[%_\\]/g, (ch) => `\\${ch}`);
    add(`(${c("code")} ILIKE '%' || ? || '%' OR ${c("developer_unit_code")} ILIKE '%' || ? || '%' OR ${c("compound")} ILIKE '%' || ? || '%')`, like, like, like);
  }
  return out;
}

/** Appends conditions to a caller's where list and args (Postgres $n numbering). */
function appendTo(where, args, list) {
  for (const { sql, values } of list) {
    let s = sql;
    for (const v of values) {
      args.push(v);
      s = s.replace("?", `$${args.length}`);
    }
    where.push(s);
  }
}

module.exports = { read, conditions, appendTo, OLD_AFTER_DAYS };
