// scripts/seed-projects.js — Test data for the developer catalogue: 20 projects, 10 of them in one area (New Obour), to try the search by
// place, feature, developer, bedrooms and price. Each project is made the way a broker adds one: a pasted launch message is read
// (services/projectPaste.js) and saved (Catalogue.saveProject), so its rows (offers, facts, features, place) are real. Three
// messages are real samples; the rest follow the same style. Safe to run again: the seeded projects are replaced.
// Usage:
//   node --env-file=.env scripts/seed-projects.js [--agency <id>]
"use strict";

const { createPool } = require("../lib/db");
const Catalogue = require("../services/catalogue");
const ProjectPaste = require("../services/projectPaste");
const Suggest = require("../services/placeSuggest");
const Samples = require("../tests/fixtures/project-pastes");

// name, developer, place words (as a broker writes them), feddan, bedrooms, price from, down %, years, delivery year, what the units have.
const MORE = [
  // New Obour: 8 more (two of the real samples are in New Obour too: Arabisk's New Balance and Jazeel).
  ["ZEN OBOUR", "ORIENT DEVELOPMENT", "العبور الجديدة", 22, [2, 3], 3200000, 10, 8, 2029, ["جنينة خاصة", "فيو لاجون"]],
  ["SKYLINE OBOUR", "NILE URBAN", "New Obour", 12, [3, 4], 4800000, 5, 9, 2030, ["روف", "ناصية"]],
  ["PALMA GATE", "ORIENT DEVELOPMENT", "العبور الجديدة", 30, [2, 3, 4], 2700000, 5, 10, 2030, ["جنينة", "نادي"]],
  ["OBOUR HEIGHTS", "DELTA PROPERTIES", "New Obour", 8, [1, 2], 1900000, 10, 7, 2028, ["أسانسير", "جراج"]],
  ["LAGOON VIEW OBOUR", "NILE URBAN", "العبور الجديدة", 40, [3, 4, 5], 6900000, 15, 8, 2029, ["فيو لاجون", "حمام سباحة خاص"]],
  ["GOLDEN OBOUR", "DELTA PROPERTIES", "New Obour", 6, [2, 3], 3500000, 10, 6, 2027, ["بلكونة", "تراس"]],
  ["OBOUR VILLAS", "ORIENT DEVELOPMENT", "العبور الجديدة", 18, [4, 5], 11500000, 20, 8, 2031, ["فيلا", "جنينة خاصة", "حمام سباحة خاص"]],
  ["OBOUR GARDENS", "NILE URBAN", "New Obour", 16, [2, 3], 4400000, 10, 8, 2029, ["جنينة خاصة", "بلكونة"]],
  // New Cairo
  ["HYDE EDGE", "ROYAL GROUP", "التجمع الخامس", 55, [2, 3, 4], 7800000, 10, 8, 2029, ["روف", "فيو جاردن"]],
  ["MIVIDA VIEW", "EMAAR PROPERTIES", "New Cairo", 90, [3, 4], 9800000, 10, 8, 2029, ["جنينة خاصة", "فيو لاجون"]],
  ["GOLDEN SQUARE ONE", "ROYAL GROUP", "المربع الذهبي", 10, [1, 2], 5200000, 10, 7, 2028, ["اسانسير", "جراج"]],
  // New Capital
  ["CAPITAL PARK", "NILE URBAN", "العاصمة الإدارية الجديدة", 25, [2, 3], 4100000, 10, 8, 2029, ["فيو جاردن", "بلكونة"]],
  ["MU23 TOWER", "DELTA PROPERTIES", "MU23", 2, [1, 2], 3300000, 15, 6, 2028, ["اسانسير"]],
  ["ADMIN GATE", "ORIENT DEVELOPMENT", "New Capital", 35, [3, 4], 6200000, 5, 10, 2030, ["روف", "جراج"]],
  // Sheikh Zayed and 6th of October
  ["ZAYED LAKES", "ROYAL GROUP", "الشيخ زايد", 48, [3, 4, 5], 12500000, 10, 8, 2029, ["فيو لاجون", "جنينة خاصة"]],
  ["ZAYED CENTRAL", "EMAAR PROPERTIES", "Sheikh Zayed", 14, [2, 3], 6900000, 10, 7, 2028, ["اسانسير", "جراج"]],
  ["OCTOBER HILLS", "DELTA PROPERTIES", "6th of October", 28, [2, 3], 3900000, 10, 9, 2029, ["نادي", "جنينة"]]
];

const message = ([name, dev, place, acres, beds, price, down, years, year, has]) => `🔥 إطلاق جديد
${name}
من ${dev}
في ${place}
مساحة ${acres} فدان
وحدات من ${beds.map((b) => `${b} غرف`).join(" و")}
${has.join("، ")}
السعر يبدأ من ${price.toLocaleString("en-US")} جنيه
مقدم ${down}% وتقسيط حتى ${years} سنين
استلام ${year}`;

const MESSAGES = [Samples.ARABISK, Samples.JAZEEL, Samples.PMC, ...MORE.map(message)];

function opt(args, key, dflt = null) {
  return args.includes(key) ? args[args.indexOf(key) + 1] : dflt;
}

async function agencyOf(pool, args) {
  const id = opt(args, "--agency");
  if (id) return id;
  const { rows } = await pool.query("SELECT a.id FROM agencies a JOIN brokers b ON b.agency_id = a.id AND b.phone_normalized = '201119998044' LIMIT 1");
  if (!rows[0]) throw new Error("Agency not found (pass --agency <id>).");
  return rows[0].id;
}

/** Adds (or replaces) the 20 projects of the agency through its first manager. Returns [{ name, place, developer }]. */
async function seedProjects(pool, agencyId) {
  const { rows } = await pool.query("SELECT * FROM brokers WHERE agency_id = $1 AND is_active AND role IN ('owner', 'admin', 'manager') ORDER BY created_at LIMIT 1", [agencyId]);
  const actor = rows[0];
  if (!actor) throw new Error("The agency has no manager to add projects as.");
  Suggest.resetCache();
  const out = [];
  for (const text of MESSAGES) {
    const read = await ProjectPaste.read(pool, actor, text, "en");
    const input = ProjectPaste.formInput(text, read);
    // Run again: the project with this name is replaced (its rows go with it).
    await pool.query("DELETE FROM projects WHERE agency_id = $1 AND lower(btrim(name)) = lower($2)", [agencyId, input.name]);
    const r = await Catalogue.saveProject(pool, actor, input);
    if (r.error) throw new Error(`${input.name}: ${r.error} ${r.field || ""}`);
    out.push({ name: input.name, place: read.place ? read.place.label : null, developer: input.developer_name || null });
  }
  return out;
}

async function main() {
  const pool = createPool();
  try {
    const agencyId = await agencyOf(pool, process.argv.slice(2));
    const list = await seedProjects(pool, agencyId);
    console.log(JSON.stringify({ projects: list.length, byPlace: list.reduce((m, p) => ({ ...m, [p.place || "no place"]: (m[p.place || "no place"] || 0) + 1 }), {}) }, null, 2));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { seedProjects, MESSAGES };
