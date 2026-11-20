// domain/analyticsBands.js — Fixed bands and small statistics for the market analytics (pure).
// Bands are fixed EGP ranges per sale/rent (no quantiles of the data), so two nights never disagree about a band.
"use strict";

const Stages = require("./leadStages");
const WinLoss = require("./winLoss");

const BEDROOM_BANDS = ["0", "1", "2", "3", "4", "5+"];
// Upper edges (exclusive) in EGP; the last band is open. Sale: price. Rent: price per month.
const BUDGET_EDGES = {
  sale: [1e6, 2e6, 3e6, 5e6, 8e6, 15e6],
  rent: [1e4, 2e4, 4e4, 8e4]
};
const fmtEdge = (v) => (v >= 1e6 ? `${v / 1e6}M` : `${v / 1e3}k`);
function budgetBands(listingType) {
  const e = BUDGET_EDGES[listingType] || [];
  if (!e.length) return [];
  return [`<${fmtEdge(e[0])}`, ...e.slice(1).map((v, i) => `${fmtEdge(e[i])}-${fmtEdge(v)}`), `${fmtEdge(e[e.length - 1])}+`];
}

/** 0..4 or "5+"; null/unknown → null. */
function bedroomBand(n) {
  if (n === null || n === undefined || n === "") return null;
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return null;
  return v >= 5 ? "5+" : String(Math.floor(v));
}

/** The band of an amount for sale or rent; "any" when there is no amount or no type. */
function budgetBand(listingType, amount) {
  const e = BUDGET_EDGES[listingType];
  const v = Number(amount);
  if (!e || !(v > 0)) return "any";
  const bands = budgetBands(listingType);
  const i = e.findIndex((edge) => v < edge);
  return bands[i === -1 ? e.length : i];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * One logged search → its cell { area_key, property_type, listing_type, bedroom_band, budget_band }.
 * Reads only the filters the search used (never its words). area_key is the first place of kind "area" (the caller maps it to an id).
 */
function searchCell(used) {
  const f = used && typeof used === "object" ? used : {};
  const lt = f.listing_type === "sale" || f.listing_type === "rent" ? f.listing_type : "any";
  const types = arr(f.property_types).filter((x) => typeof x === "string");
  const area = arr(f.places).find((p) => p && p.kind === "area" && typeof p.key === "string");
  const scoped = arr(f.area_scope && f.area_scope.areas).find((id) => typeof id === "string" && UUID.test(id));
  let bed = null;
  const min = f.bedrooms_min ?? null;
  const max = f.bedrooms_max ?? null;
  if (min !== null && max !== null && Number(min) === Number(max)) bed = bedroomBand(min);
  else if (min !== null) bed = bedroomBand(min);
  const currencyOk = !f.currency || f.currency === "EGP";
  const amount = f.price_max ?? f.price_min ?? null;
  return {
    area_id: scoped || null,
    area_key: area ? area.key : null,
    property_type: types.length === 1 ? types[0].slice(0, 40) : "any",
    listing_type: lt,
    bedroom_band: bed || "any",
    budget_band: currencyOk && lt !== "any" ? budgetBand(lt, amount) : "any"
  };
}

const KNOWN_SOURCES = Stages.SOURCES.map(([en]) => en);
/** A lead's free-text source → one of the fixed source names, else "Other". */
function sourceKey(source) {
  const s = String(source || "").trim();
  if (!s) return "Unknown";
  const hit = KNOWN_SOURCES.find((k) => k.toLowerCase() === s.toLowerCase()) || Stages.SOURCES.find(([, ar]) => ar === s)?.[0];
  return hit || "Other";
}

/** A lost reason (free text) → a fixed category key (never the text itself). */
const lostKey = (reason) => WinLoss.classify(reason);

/** Linear-interpolated percentile (p 0..1) of numbers; null for none. */
function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = (v.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return v[lo] + (v[hi] - v[lo]) * (idx - lo);
}
const median = (values) => percentile(values, 0.5);
const round = (n, d = 0) => (n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d);

/** The Cairo calendar day (YYYY-MM-DD) of an instant. */
const cairoDay = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
const cairoHour = (d) => Number(new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", hour12: false })) % 24;
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

module.exports = { BEDROOM_BANDS, BUDGET_EDGES, budgetBands, bedroomBand, budgetBand, searchCell, sourceKey, lostKey, percentile, median, round, cairoDay, cairoHour, addDays };
