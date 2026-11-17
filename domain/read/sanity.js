// domain/read/sanity.js — The last check on what a post reader found (pure). A value that cannot be a real unit's price, size or
// room count is dropped, and the reason is kept: empty beats wrong (rule B). This is the safety net for a misreading nobody wrote a
// rule for yet, such as a plot size read as a price in millions. Only cell names and reasons are ever logged.
"use strict";

const { readAmount } = require("./amount");

const FOREIGN = /(\$|usd|us\s*dollars?|dollars?|دولار|€|eur\b|euros?|يورو|£|gbp\b)/i;
const SEVERAL = /[\/]|short|long|monthly|yearly/i;
const HAS_UNIT = /(مليون|ملايين|million|mil\b|الف|ألف|\bk\b)/i;

const num = (v) => {
  const n = Number(String(v ?? "").replace(/,/g, "").match(/\d+(?:\.\d+)?/)?.[0]);
  return Number.isFinite(n) ? n : null;
};

/**
 * @param {object} cells the post's cells (strings)
 * @returns {Array<{cell: string, why: string}>} the cells that cannot be right
 */
function suspects(cells = {}) {
  const out = [];
  const area = num(cells.area_value);
  const land = num(cells.land_area);
  const sale = cells.listing_type === "sale";
  const rent = cells.listing_type === "rent";

  if (area !== null && (area < 15 || area > 50000)) out.push({ cell: "area_value", why: "area_range" });
  if (land !== null && (land < 15 || land > 200000)) out.push({ cell: "land_area", why: "area_range" });
  if (num(cells.bedrooms) !== null && num(cells.bedrooms) > 12) out.push({ cell: "bedrooms", why: "rooms_range" });
  if (num(cells.bathrooms) !== null && num(cells.bathrooms) > 12) out.push({ cell: "bathrooms", why: "rooms_range" });
  if (num(cells.floor) !== null && num(cells.floor) > 60) out.push({ cell: "floor", why: "floor_range" });

  const raw = cells.price_value;
  if (raw === undefined || FOREIGN.test(String(raw)) || SEVERAL.test(String(raw))) return out;

  // The price is the size said again, with only a Latin m or no unit word ("land area 420m" read as "420m"). The amount reader is
  // not sure about that shape, so it is checked on its own.
  const lead = num(raw);
  const sizes = [area, land].filter((x) => x !== null && x >= 15);
  if (lead !== null && sizes.includes(lead) && !HAS_UNIT.test(String(raw))) {
    out.push({ cell: "price_value", why: "price_is_size" });
    return out;
  }

  // Past here only a price the amount reader is sure of is checked; anything else is left to the review.
  const r = readAmount(String(raw));
  const p = r && r.sure ? r.value : null;
  if (p === null || p === undefined) return out;
  if (sizes.some((s) => p === s * 1e6 || p === s * 1e3)) out.push({ cell: "price_value", why: "price_is_size" });
  else if (sale && (p < 100000 || p > 2e9)) out.push({ cell: "price_value", why: p < 100000 ? "price_low" : "price_high" });
  else if (sale && area && (p / area < 1500 || p / area > 2e6)) out.push({ cell: "price_value", why: "price_per_m2" });
  else if (rent && (p < 500 || p > 3e6)) out.push({ cell: "price_value", why: p < 500 ? "price_low" : "price_high" });
  else if (!sale && !rent && p > 2e9) out.push({ cell: "price_value", why: "price_high" });
  return out;
}

module.exports = { suspects };
