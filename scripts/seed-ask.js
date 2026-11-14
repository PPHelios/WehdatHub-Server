// scripts/seed-ask.js — Test data for Ask: about 15 primary projects with offers written in their notes (the same text a
// broker writes), a few with no sizes, and one sign-in per role for the test agency. Runs after scripts/seed-poc.js seed
// (which adds units and leads). Safe to run again: the test projects are replaced, the sign-ins are kept.
// Usage:
//   node --env-file=.env scripts/seed-ask.js seed [--agency <id>]          adds the projects and the role sign-ins
//   node --env-file=.env scripts/seed-ask.js login <manager|owner|broker1|broker2|agent> [--agency <id>]
//                                                                          prints a new 6-digit code (valid 5 minutes)
// Sign in on the website with the phone number of that role and the code. No Telegram is needed.
"use strict";

const { createPool } = require("../lib/db");
const WebAuth = require("../lib/webAuth");

const TEST_PROJECTS = [
  { name: "جزيل ريزدنس", name_en: "JAZEEL RESIDENCE", district: "Obour", city: "Cairo", status: "active", notes: "🔥 يونت 110 م الدور الاول سعرها = 2,900,000 مقدم 10% = 290,000 قسط شهري على 8 سنين = 27,187\n🔥 يونت 153 م سعرها = 4,100,000 مقدم 10% = 410,000 قسط شهري = 21,000 تقسيط 10 سنين" },
  { name: "ارابيسك نيو عبور", name_en: "Arabisk New Obour", district: "New Obour", city: "Cairo", status: "active", notes: "شقة 130 م سعرها = 3,900,000 مقدم 5% = 195,000 تقسيط 8 سنين\nشقة 3 غرف 150 م سعرها = 4,500,000 مقدم 5% = 225,000 تقسيط 8 سنين" },
  { name: "PMC Mall", name_en: "PMC Mall", district: "Sheikh Zayed", city: "Giza", status: "active", notes: "مكتب 60 م سعرها = 6,000,000 مقدم 10% = 600,000 تقسيط 7 سنين" },
  { name: "هايد بارك", name_en: "Hyde Park", district: "New Cairo", city: "Cairo", status: "active", notes: "شقة 3 غرف 180 م سعرها = 5,400,000 مقدم 10% = 540,000 قسط شهري = 30,000 على 6 سنين\nشقة 2 غرف 120 م سعرها = 3,800,000 مقدم 10% = 380,000 قسط شهري = 21,000" },
  { name: "كابيتال جاردنز", name_en: "Capital Gardens", district: "New Capital", city: "Cairo", status: "active", notes: "شقة 95 م سعرها = 2,600,000 مقدم 15% = 390,000 تقسيط 7 سنين\nشقة 140 م سعرها = 3,700,000 مقدم 15% = 555,000 تقسيط 7 سنين" },
  { name: "ميڤيدا", name_en: "Mivida", district: "New Cairo", city: "Cairo", status: "active", notes: "فيلا 320 م سعرها = 18,000,000 مقدم 20% = 3,600,000 تقسيط 8 سنين\nشقة 175 م سعرها = 6,200,000 مقدم 10% = 620,000 تقسيط 8 سنين" },
  { name: "ماونتن فيو", name_en: "Mountain View iCity", district: "New Cairo", city: "Cairo", status: "active", notes: "شقة 130 م سعرها = 4,100,000 مقدم 10% = 410,000 قسط شهري = 25,000 على 7 سنين\nشقة 90 م سعرها = 2,900,000 مقدم 10% = 290,000 قسط شهري = 18,000" },
  { name: "الكمبوند الجديد", name_en: "Sample Compound A", district: "Obour", city: "Cairo", status: "active", notes: "شقة سعرها = 2,500,000 مقدم 10% = 250,000 تقسيط 5 سنين" },
  { name: "ريزيدنس تاون", name_en: "Town Residence", district: "Madinaty", city: "Cairo", status: "active", notes: "شقة 165 م سعرها = 4,900,000 مقدم 10% = 490,000 تقسيط 8 سنين\nشقة 2 غرف 110 م سعرها = 3,300,000 مقدم 10% = 330,000" },
  { name: "سكاي لاين", name_en: "Skyline Towers", district: "6th of October", city: "Giza", status: "active", notes: "شقة 210 م سعرها = 7,800,000 مقدم 15% = 1,170,000 تقسيط 10 سنين" },
  { name: "جرين بارك", name_en: "Green Park Villas", district: "Sheikh Zayed", city: "Giza", status: "active", notes: "فيلا مستقلة سعرها = 22,000,000 مقدم 20% = 4,400,000 تقسيط 9 سنين" },
  { name: "نيو ليجاسي", name_en: "New Legacy", district: "New Cairo", city: "Cairo", status: "active", notes: "شقة 100 م سعرها = 3,000,000 مقدم 10% = 300,000 تقسيط 6 سنين\nشقة 150 م سعرها = 4,400,000 مقدم 10% = 440,000 تقسيط 6 سنين" },
  { name: "بيفرلي هيلز", name_en: "Beverly Hills", district: "Sheikh Zayed", city: "Giza", status: "active", notes: "شقة 125 م سعرها = 4,000,000 مقدم 10% = 400,000 تقسيط 8 سنين" },
  { name: "رويال ستي", name_en: "Royal City", district: "Sheikh Zayed", city: "Giza", status: "active", notes: "مكتب 45 م سعرها = 2,200,000 مقدم 10% = 220,000 تقسيط 5 سنين" },
  // Projects with offers that have no sizes written: Ask must say so instead of "no match".
  { name: "كابيتال تاور", name_en: "Capital Tower", district: "Obour", city: "Cairo", status: "active", notes: "شقة سعرها = 3,100,000 مقدم 10% = 310,000 تقسيط 7 سنين" }
];

const LOGIN_ROLES = {
  manager: { name: "Test Manager", phone: "01100000001", role: "manager", lang: "ar" },
  owner: { name: "Test Owner", phone: "01100000002", role: "owner", lang: "ar" },
  broker1: { name: "Test Broker One", phone: "01100000003", role: "broker", lang: "ar" },
  broker2: { name: "Test Broker Two", phone: "01100000004", role: "broker", lang: "en" },
  agent: { name: "Test Agent", phone: "01100000005", role: "agent", lang: "en" }
};

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

/** Replaces the test projects of this agency (by English name) with the list above. */
async function seedProjects(pool, agencyId) {
  await pool.query("DELETE FROM projects WHERE agency_id = $1 AND name_en = ANY($2::text[])", [agencyId, TEST_PROJECTS.map((p) => p.name_en)]);
  for (const p of TEST_PROJECTS) {
    await pool.query(
      "INSERT INTO projects (agency_id, name, name_en, district, city, status, notes) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [agencyId, p.name, p.name_en, p.district, p.city, p.status, p.notes]
    );
  }
  return TEST_PROJECTS.length;
}

/** One sign-in per role. Existing phones are kept; the owner and manager are the agency's own. */
async function seedSignIns(pool, agencyId) {
  const made = [];
  for (const [key, r] of Object.entries(LOGIN_ROLES)) {
    if (key === "owner" || key === "manager") continue;
    const digits = "2" + r.phone;
    const found = await pool.query("SELECT id FROM brokers WHERE phone_normalized = $1", [digits]);
    if (!found.rowCount) {
      await pool.query(
        "INSERT INTO brokers (agency_id, phone_number, name, role, preferred_lang, is_active) VALUES ($1, $2, $3, $4, $5, true)",
        [agencyId, digits, r.name, r.role, r.lang]
      );
    }
    made.push(`${key}: ${r.role} ${r.phone}`);
  }
  return made;
}

async function login(pool, agencyId, key) {
  const r = LOGIN_ROLES[key];
  if (!r) throw new Error(`Unknown role. Use one of: ${Object.keys(LOGIN_ROLES).join(", ")}`);
  const digits = "2" + r.phone;
  let row = (await pool.query("SELECT * FROM brokers WHERE agency_id = $1 AND phone_normalized = $2", [agencyId, digits])).rows[0];
  if (!row && (key === "owner" || key === "manager")) {
    row = (await pool.query("SELECT * FROM brokers WHERE agency_id = $1 AND role = $2 AND is_active ORDER BY created_at LIMIT 1", [agencyId, r.role])).rows[0];
  }
  if (!row) throw new Error(`No sign-in for ${key}. Run the seed first.`);
  const code = await WebAuth.issueLoginCode(pool, row);
  return { role: key, phone: row.phone_normalized, code, valid: "5 minutes" };
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const pool = createPool();
  try {
    const agencyId = await agencyOf(pool, args);
    if (cmd === "seed") {
      const projects = await seedProjects(pool, agencyId);
      const signIns = await seedSignIns(pool, agencyId);
      console.log(JSON.stringify({ projects, signIns, next: "node --env-file=.env scripts/seed-ask.js login <role>" }, null, 2));
    } else if (cmd === "login") {
      console.log(JSON.stringify(await login(pool, agencyId, args[1]), null, 2));
    } else {
      console.log("Usage: seed-ask.js <seed|login <role>> [--agency <id>]");
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

module.exports = { TEST_PROJECTS, LOGIN_ROLES };
