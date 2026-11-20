// domain/analyticsMarket.js — One day's market cells from unit rows (pure). Input rows hold no personal data: ids of the agency
// and the place, bands, numbers and flags. Each unit counts in four wider and wider cells (place+bedrooms, place, the place's
// parent, everywhere); a cell is kept only when it passes the privacy thresholds (domain/analyticsPrivacy.js), so a small
// cell is not written as detail and its units still count in the wider cell that passes.
"use strict";

const Privacy = require("./analyticsPrivacy");
const Bands = require("./analyticsBands");

const MIN_SOLD = 5; // days-to-close and asking-vs-closed need at least this many closed units in the cell

/**
 * @param {Array} rows  { agency_id, area_id, parent_id, property_type, listing_type, bedroom_band, price, area_m2, active, is_new, removed, sold, days_to_close, ask_gap_pct }
 * @param {string} day  YYYY-MM-DD
 * @returns {Array} cells ready for analytics_market_daily
 */
function computeCells(rows, day) {
  const cells = new Map();
  const touch = (key, base, r) => {
    let c = cells.get(key);
    if (!c) {
      c = { ...base, agencies: new Set(), rows_n: 0, listings_active: 0, new_listings: 0, removed_listings: 0, sold_count: 0, ppm2: [], prices: [], days: [], gaps: [] };
      cells.set(key, c);
    }
    c.agencies.add(r.agency_id);
    c.rows_n += 1;
    if (r.active) {
      c.listings_active += 1;
      if (r.price > 0) c.prices.push(r.price);
      if (r.price > 0 && r.area_m2 > 0) c.ppm2.push(r.price / r.area_m2);
    }
    if (r.is_new) c.new_listings += 1;
    if (r.removed) c.removed_listings += 1;
    if (r.sold) {
      c.sold_count += 1;
      if (Number.isFinite(r.days_to_close)) c.days.push(r.days_to_close);
      if (Number.isFinite(r.ask_gap_pct)) c.gaps.push(r.ask_gap_pct);
    }
  };
  for (const r of rows) {
    const t = r.property_type || "all";
    const lt = r.listing_type === "sale" || r.listing_type === "rent" ? r.listing_type : "all";
    const levels = [];
    if (r.area_id) {
      if (r.bedroom_band) levels.push([r.area_id, t, lt, r.bedroom_band]);
      levels.push([r.area_id, t, lt, "all"]);
      if (r.parent_id) levels.push([r.parent_id, t, lt, "all"]);
    }
    levels.push([null, t, lt, "all"], [null, "all", lt, "all"]);
    const seen = new Set();
    for (const [area_id, property_type, listing_type, bedroom_band] of levels) {
      const key = `${area_id}|${property_type}|${listing_type}|${bedroom_band}`;
      if (seen.has(key)) continue;
      seen.add(key);
      touch(key, { day, area_id, property_type, listing_type, bedroom_band }, r);
    }
  }
  const out = [];
  for (const c of cells.values()) {
    const cell = { agencies_n: c.agencies.size, rows_n: c.rows_n };
    if (!Privacy.passes(cell)) continue;
    const enoughPrices = c.ppm2.length >= Privacy.MIN_ROWS && c.agencies.size >= Privacy.MIN_AGENCIES;
    const enoughSold = c.days.length >= MIN_SOLD && c.sold_count >= MIN_SOLD;
    out.push({
      day: c.day, area_id: c.area_id, property_type: c.property_type, listing_type: c.listing_type, bedroom_band: c.bedroom_band,
      listings_active: c.listings_active, new_listings: c.new_listings, removed_listings: c.removed_listings,
      price_m2_p25: enoughPrices ? Bands.round(Bands.percentile(c.ppm2, 0.25)) : null,
      price_m2_p50: enoughPrices ? Bands.round(Bands.percentile(c.ppm2, 0.5)) : null,
      price_m2_p75: enoughPrices ? Bands.round(Bands.percentile(c.ppm2, 0.75)) : null,
      price_p50: enoughPrices ? Bands.round(Bands.median(c.prices)) : null,
      sold_count: c.sold_count,
      median_days_to_close: enoughSold ? Bands.round(Bands.median(c.days), 1) : null,
      asking_vs_closed_pct: enoughSold && c.gaps.length >= MIN_SOLD ? Bands.round(Bands.median(c.gaps), 1) : null,
      agencies_n: cell.agencies_n, rows_n: cell.rows_n
    });
  }
  return out;
}

module.exports = { computeCells, MIN_SOLD };
