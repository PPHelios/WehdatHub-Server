// tests/parsers/recall.js — The no-miss rule, offline. For every NCH unit, builds queries from the unit's own fields
// in varied phrasing and checks that the parsed filters never rule that unit out (Rule A: a matching unit must stay).
// A query "excludes" its unit when a hard filter the parser read contradicts the unit's own data.
// Usage: node tests/parsers/recall.js [--write-baseline]   (errors only: prints the totals and the first misses)
"use strict";

const fs = require("fs");
const path = require("path");
const Q = require("../../domain/searchQuery");

const units = require("./recall/nch-units.json");

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const arDigits = (n) => String(n).replace(/[0-9]/g, (d) => AR_DIGITS[d]);
const TYPE_AR = { apartment: "شقة", villa: "فيلا", studio: "استوديو", duplex: "دوبلكس", townhouse: "تاون هاوس", penthouse: "بنتهاوس", twin_villa: "توين هاوس", maisonette: "ميزونيت", basement: "بدروم", triplex: "تريبلكس", sky_loft: "سكاي لوفت" };
const TYPE_EN = { apartment: "apartment", villa: "villa", studio: "studio", duplex: "duplex", townhouse: "townhouse", penthouse: "penthouse", twin_villa: "twin house", maisonette: "maisonette", basement: "basement", triplex: "triplex", sky_loft: "sky loft" };

function budgetAr(u) {
  if (!u.price) return "";
  if (u.listing_type === "rent") return `${Math.ceil(u.price / 5000) * 5} ألف`;
  return `${Math.ceil(u.price / 500000) / 2} مليون`;
}

/** Up to 6 queries per unit, from its own fields. */
function queriesFor(u) {
  const tAr = TYPE_AR[u.property_type] || "";
  const tEn = TYPE_EN[u.property_type] || "unit";
  const place = u.compound || u.district || u.city || "";
  const lt = u.listing_type === "rent" ? "للايجار" : "للبيع";
  const ltEn = u.listing_type === "rent" ? "rent" : "sale";
  const rooms = u.bedrooms && u.property_type !== "studio" ? u.bedrooms : null;
  const q = [];
  q.push([tAr, rooms ? `${rooms} غرف` : "", place ? `في ${place}` : "", lt].filter(Boolean).join(" "));
  q.push([rooms ? `${rooms} bedroom` : "", tEn, `for ${ltEn}`, place ? `in ${place}` : ""].filter(Boolean).join(" "));
  const b = budgetAr(u);
  if (b) q.push([tAr, rooms ? `${rooms} نوم` : "", place, lt, `بادجت ${b}`].filter(Boolean).join(" "));
  if (rooms) q.push([tAr, `${arDigits(rooms)} نوم`, place ? `في ${place}` : "", lt].filter(Boolean).join(" "));
  if (place) q.push(`${place} ${lt}`);
  q.push(`${tAr || tEn} ${lt}`.trim());
  return q;
}

/** The hard filters the parser read that contradict the unit; empty = the unit stays in the results. */
function excludedBy(f, u) {
  const bad = [];
  if (f.listing_type && f.listing_type !== u.listing_type) bad.push("listing_type");
  if (f.property_types?.length && u.property_type !== "unknown" && !f.property_types.includes(u.property_type)) bad.push("property_types");
  if (u.bedrooms != null) {
    if (f.bedrooms_min != null && u.bedrooms < f.bedrooms_min) bad.push("bedrooms_min");
    if (f.bedrooms_max != null && u.bedrooms > f.bedrooms_max) bad.push("bedrooms_max");
  }
  if (u.price != null) {
    if (f.price_max != null && u.price > f.price_max) bad.push("price_max");
    if (f.price_min != null && u.price < f.price_min) bad.push("price_min");
  }
  if (u.area != null) {
    if (f.area_min != null && u.area < f.area_min) bad.push("area_min");
    if (f.area_max != null && u.area > f.area_max) bad.push("area_max");
  }
  return bad;
}

function run() {
  const misses = [];
  let total = 0;
  for (const u of units) {
    queriesFor(u).forEach((query, i) => {
      total++;
      let bad;
      try {
        bad = excludedBy(Q.fallbackParse(query).filters, u);
      } catch {
        bad = ["threw"];
      }
      if (bad.length) misses.push({ key: `${u.code}#${i}`, query, bad });
    });
  }
  return { total, misses };
}

module.exports = { run, queriesFor, excludedBy };

if (require.main === module) {
  const { total, misses } = run();
  const pct = (100 * (total - misses.length)) / total;
  console.log(`recall: ${total - misses.length} of ${total} queries keep their unit (${pct.toFixed(1)}%); units: ${units.length}`);
  const byReason = {};
  for (const m of misses) for (const b of m.bad) byReason[b] = (byReason[b] || 0) + 1;
  console.log("excluded by:", JSON.stringify(byReason));
  for (const m of misses.slice(0, 15)) console.log(`MISS ${m.key} [${m.bad.join(",")}] ${m.query}`);
  if (process.argv.includes("--write-baseline")) {
    fs.writeFileSync(path.join(__dirname, "baseline", "recall-baseline.json"), JSON.stringify({ total, excluded: misses.map((m) => m.key) }) + "\n");
    console.log("baseline written");
  }
}
