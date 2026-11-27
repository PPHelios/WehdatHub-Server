// scripts/seed-assistant-qa.js — Test data for the Ask assistant QA loop (npm run qa:assistant): leads in every queue,
// viewings, deals, sources, lost reasons, leases ending soon and stale units, owned by the seed-ask sign-ins.
// Usage: node --env-file=.env scripts/seed-assistant-qa.js seed [--agency <id>]
// Safe to run again: the rows it owns are deleted first, then made again. It owns: leads named "QA ..." with a 2010000xxxxx
// phone (their deals, viewings, events), units whose owner is "QA Owner", and the broker "QA Team Lead". Nothing else is touched.
// Fake phones only; nobody is messaged. It runs seed-ask's sign-ins first if they do not exist.
"use strict";

const { withTransaction } = require("../lib/db");
const L = require("../lib/listing");
const Rules = require("../domain/fieldRules");

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const TEAM_LEAD_PHONE = "201000099001";
const phoneOf = (n) => `2010000${String(10000 + n).slice(-5)}`; // 12 digits, fake

/** Removes what an earlier run made (only rows tagged as QA). */
async function cleanOwned(pool, agencyId) {
  const qa = "SELECT id FROM leads WHERE agency_id = $1 AND name LIKE 'QA %' AND phone_e164 LIKE '2010000%'";
  await pool.query(`DELETE FROM saved_searches WHERE agency_id = $1 AND lead_id IN (${qa})`, [agencyId]);
  await pool.query(`DELETE FROM deals WHERE agency_id = $1 AND lead_id IN (${qa})`, [agencyId]);
  await pool.query(`DELETE FROM viewings WHERE agency_id = $1 AND lead_id IN (${qa})`, [agencyId]);
  await pool.query(`DELETE FROM lead_events WHERE agency_id = $1 AND lead_id IN (${qa})`, [agencyId]);
  const l = await pool.query("DELETE FROM leads WHERE agency_id = $1 AND name LIKE 'QA %' AND phone_e164 LIKE '2010000%'", [agencyId]);
  const own = "SELECT id FROM listings WHERE agency_id = $1 AND details->>'owner_name' = 'QA Owner'";
  await pool.query(`DELETE FROM leases WHERE agency_id = $1 AND listing_id IN (${own})`, [agencyId]);
  await pool.query(`DELETE FROM deals WHERE agency_id = $1 AND listing_id IN (${own})`, [agencyId]);
  const u = await pool.query("DELETE FROM listings WHERE agency_id = $1 AND details->>'owner_name' = 'QA Owner'", [agencyId]);
  return { leads: l.rowCount, units: u.rowCount };
}

async function actors(pool, agencyId) {
  await require("./seed-ask").seedSignIns(pool, agencyId);
  const get = async (sql, params = []) => (await pool.query(`SELECT * FROM brokers WHERE agency_id = $1 AND is_active AND ${sql} ORDER BY created_at, id LIMIT 1`, [agencyId, ...params])).rows[0];
  const owner = await get("role = 'owner'");
  const manager = await get("role IN ('manager', 'admin')");
  const broker1 = await get("phone_normalized = '201100000003'");
  const broker2 = await get("phone_normalized = '201100000004'");
  if (!owner || !manager || !broker1 || !broker2) throw new Error("The agency needs an owner and a manager.");
  let lead = await get("role = 'team_lead'");
  if (!lead) {
    await pool.query("INSERT INTO brokers (agency_id, phone_number, name, role, preferred_lang, is_active) VALUES ($1, $2, 'QA Team Lead', 'team_lead', 'en', true)", [agencyId, TEAM_LEAD_PHONE]);
    lead = await get("phone_normalized = $2", [TEAM_LEAD_PHONE]);
  }
  if (lead && !broker2.team_lead_id) await pool.query("UPDATE brokers SET team_lead_id = $2 WHERE id = $1", [broker2.id, lead.id]);
  await seedNamedTeams(pool, agencyId);
  return { owner, manager, broker1, broker2, teamLead: lead };
}

// Named brokers and teams, so questions like "Sara's team", "stats for Mona", "فريق احمد" resolve (names as the router matches them).
// Sara and Omar already exist from seed-ask: they are made team leads here. The rest are QA brokers (fake 2010000990xx phones).
const NAMED = [
  { name: "QA Ahmed احمد", phone: "201000099002", lead: true },
  { name: "QA Mohamed محمد", phone: "201000099003", lead: true },
  { name: "QA Mona منى", phone: "201000099004", under: "Sara" },
  { name: "QA Ali علي", phone: "201000099005", under: "QA Ahmed" },
  { name: "QA Hana هنا", phone: "201000099006", under: "Omar" },
  { name: "QA Youssef يوسف", phone: "201000099007", under: "QA Mohamed" }
];

async function seedNamedTeams(pool, agencyId) {
  const find = async (like) => (await pool.query("SELECT id FROM brokers WHERE agency_id = $1 AND name LIKE $2 AND is_active ORDER BY created_at, id LIMIT 1", [agencyId, `${like}%`])).rows[0];
  for (const n of NAMED) {
    if (!(await pool.query("SELECT 1 FROM brokers WHERE phone_number = $1 OR phone_normalized = $1", [n.phone])).rows.length) {
      await pool.query("INSERT INTO brokers (agency_id, phone_number, name, role, preferred_lang, is_active) VALUES ($1, $2, $3, $4, 'en', true)", [agencyId, n.phone, n.name, n.lead ? "team_lead" : "broker"]);
    }
  }
  for (const first of ["Sara", "Omar"]) await pool.query("UPDATE brokers SET role = 'team_lead' WHERE agency_id = $1 AND name LIKE $2 AND role IN ('broker', 'agent')", [agencyId, `${first} %`]);
  for (const n of NAMED.filter((x) => x.under)) {
    const tl = await find(n.under);
    if (tl) await pool.query("UPDATE brokers SET team_lead_id = $3 WHERE agency_id = $1 AND phone_normalized = $2", [agencyId, n.phone, tl.id]);
  }
}

const UNIT_DEFS = [
  { type: "apartment", sale: 5_200_000, area: 140, beds: 3, baths: 2, compound: "QA Heights", district: "New Cairo" },
  { type: "apartment", sale: 3_100_000, area: 100, beds: 2, baths: 1, compound: "QA Heights", district: "New Cairo" },
  { type: "villa", sale: 14_000_000, area: 300, beds: 4, baths: 4, compound: "QA Gardens", district: "Sheikh Zayed" },
  { type: "apartment", rent: 18_000, area: 110, beds: 2, baths: 2, compound: "QA Heights", district: "New Cairo", lease: 20 },
  { type: "apartment", rent: 24_000, area: 130, beds: 3, baths: 2, compound: "QA Gardens", district: "Sheikh Zayed", lease: 40 },
  { type: "apartment", sale: 4_400_000, area: 120, beds: 3, baths: 2, compound: "QA Gardens", district: "Sheikh Zayed", stale: 45 },
  { type: "studio", sale: 1_900_000, area: 55, beds: 1, baths: 1, compound: "QA Heights", district: "New Cairo", stale: 60 }
];

async function seedUnits(pool, actor, agencyId) {
  const Store = require("../lib/listingStore");
  const { draftOf } = require("./seed-poc");
  for (const u of UNIT_DEFS) {
    await pool.query("INSERT INTO map_places (name_key, name_en, district, approved) VALUES ($1, $2, $3, true) ON CONFLICT (name_key) DO NOTHING", [require("../domain/mapPlaces").placeKey(u.compound), u.compound, u.district]);
  }
  await require("../services/areas").linkPlacesFromDistrict(pool);
  require("../services/mapPlaces").clearCache?.();
  const made = [];
  for (const u of UNIT_DEFS) {
    const draft = draftOf({ ...u, fin: "fully_finished", feat: [], owner: ["QA Owner", "2010000" + "88888"] });
    const ev = Rules.evaluate(L.composeFields({ draft, lang: "en" }), { lang: "en" });
    if (!ev.ok) throw new Error(`QA unit not valid: ${ev.blockers.map((b) => b.label_en).join(", ")}`);
    const res = await withTransaction(pool, (db) => Store.createListing(db, actor, { fields: ev.listing, code: null, lang: "en" }));
    if (!res.listing) throw new Error(`QA unit not created: ${JSON.stringify(res).slice(0, 200)}`);
    const id = res.listing.id;
    // Direct SQL on purpose: the seed ages the unit; applyListingPatch would stamp it fresh.
    if (u.stale) await pool.query("UPDATE listings SET updated_at = now() - make_interval(days => $2), confirmed_at = now() - make_interval(days => $2) WHERE id = $1", [id, u.stale]);
    if (u.lease) {
      // A 12-month lease that ends in `lease` days.
      await pool.query("INSERT INTO leases (agency_id, listing_id, broker_id, tenant_name, start_date, months, rent, remind) VALUES ($1, $2, $3, 'QA Tenant', (CURRENT_DATE - 365 + $4::int), 12, $5, true)", [agencyId, id, actor.id, u.lease, u.rent]);
    }
    made.push(res.listing);
  }
  return made;
}

async function seed(pool, agencyId) {
  // Nobody is messaged while the data loads.
  require("../lib/notifications").notifyBroker = async () => ({ ok: true, skipped: true });
  const Leads = require("../services/leads");
  const Deals = require("../services/deals");
  const Viewings = require("../services/viewings");
  const removed = await cleanOwned(pool, agencyId);
  const a = await actors(pool, agencyId);
  const owners = [a.broker1, a.broker2, a.manager, a.owner];
  const units = await seedUnits(pool, a.manager, agencyId);
  const sources = ["Facebook", "Website", "Referral"];
  const ids = [];
  let n = 0;

  // One lead: made through the service (events, ref, assignment), then dated by SQL so every queue is true now.
  async function lead(name, { to = owners[n % 4], ageH = 0, stage = "new", lost = null, contacted = false, extra = "", viewing = null } = {}) {
    n++;
    const res = await Leads.captureLead(pool, a.manager, { phones: phoneOf(n), name: `QA ${name}`, kind: "buyer", source: sources[n % 3], assignTo: to ? to.id : null }, { quiet: true });
    if (!res.lead) throw new Error(`QA lead "${name}" not created: ${JSON.stringify(res).slice(0, 160)}`);
    const id = res.lead.id;
    const as = to || a.manager;
    if (stage !== "new") {
      const r = await Leads.setStage(pool, as, id, { stage, lostReason: lost });
      if (r.error) throw new Error(`QA lead "${name}" stage: ${r.error}`);
    }
    await pool.query(
      `UPDATE leads SET created_at = now() - make_interval(hours => $2::int), last_activity_at = now() - make_interval(hours => $2::int),
              assigned_at = CASE WHEN assigned_broker_id IS NULL THEN NULL ELSE now() - make_interval(hours => $2::int) END,
              last_contact_at = CASE WHEN $3::boolean THEN now() - interval '1 day' ELSE NULL END ${extra} WHERE id = $1`,
      [id, ageH, contacted]
    );
    if (viewing !== null) {
      const r = await Viewings.schedule(pool, as, id, { at: new Date(Date.now() + viewing * DAY + 2 * HOUR), listing: units[0], place: "QA Heights gate" });
      if (r.error) throw new Error(`QA lead "${name}" viewing: ${r.error}`);
    }
    ids.push(id);
    return { id, as };
  }

  await lead("Unassigned A", { to: null, ageH: 2 });
  await lead("Unassigned B", { to: null, ageH: 30 });
  for (let i = 0; i < 4; i++) await lead(`Waiting ${i + 1}`, { ageH: 3 + i * 5 });
  await lead("Uncontacted fresh", { ageH: 0 });
  await lead("Approaching SLA", { ageH: 0, extra: ", response_due_at = now() + interval '10 minutes'" });
  const od = [];
  for (let i = 0; i < 3; i++) od.push(await lead(`Overdue ${i + 1}`, { stage: "contacted", contacted: true, ageH: 72 }));
  for (const o of od) await Leads.setFollowUp(pool, o.as, o.id, { at: new Date(Date.now() - DAY), kind: "call", note: "QA call back", now: new Date(Date.now() - 3 * DAY) });
  const op = await lead("Link opened", { stage: "interested", contacted: true, ageH: 48 });
  await pool.query("INSERT INTO lead_events (agency_id, lead_id, broker_id, kind, data, created_at) VALUES ($1, $2, $3, 'share_opened', '{}', now() - interval '3 hours')", [agencyId, op.id, op.as.id]);
  await lead("Viewing today", { stage: "viewing", contacted: true, ageH: 24, viewing: 0 });
  await lead("Viewing tomorrow", { stage: "viewing", contacted: true, ageH: 24, viewing: 1 });
  await lead("Viewing next week", { stage: "viewing", contacted: true, ageH: 24, viewing: 6 });
  await lead("Lost price", { stage: "lost", lost: "Budget too low", contacted: true, ageH: 96 });
  await lead("Lost other", { stage: "lost", lost: "Bought from another agency", contacted: true, ageH: 120 });
  await lead("Lost slow", { stage: "lost", lost: "No answer", contacted: true, ageH: 150 });

  // Deals: this month and last month per broker, resale (on a unit) and primary (no unit).
  const now = new Date();
  const thisMonth = new Date(now.getTime() - Math.min(2, now.getUTCDate() - 1) * DAY);
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 5 * DAY);
  let d = 0;
  for (const when of [thisMonth, lastMonth]) {
    for (const closer of owners) {
      for (const primary of [false, true]) {
        d++;
        const w = await lead(`Deal ${d}`, { to: closer, stage: "negotiation", contacted: true, ageH: 200 });
        const unit = units[d % 3];
        const r = await Deals.createDeal(pool, a.manager, {
          leadKey: w.id, unitCode: primary ? null : unit.code, market: primary ? "primary" : "resale",
          price: primary ? 6_000_000 + d * 100_000 : Number(unit.price_value), mode: "pct", pct: 2,
          dealType: "sale", status: "signed", closingBrokerId: closer.id, markSold: false, notes: "QA seed"
        }, { idemKey: `qa-seed-${d}` });
        if (r.error) throw new Error(`QA deal ${d}: ${r.error}`);
        await pool.query("UPDATE deals SET closed_at = $2, created_at = $2 WHERE agency_id = $1 AND idem_key = $3", [agencyId, when.toISOString(), `qa-seed-${d}`]);
      }
    }
  }
  // Clients with a saved request ("who wants X"): two fit the seeded New Cairo / Zayed units, one fits nothing.
  const LeadRequests = require("../services/leadRequests");
  const wants = [
    ["Wants apartment NC", owners[0], { property_types: ["apartment"], places: [{ kind: "area", key: "new_cairo" }] }],
    ["Wants villa Zayed", owners[1], { property_types: ["villa"], places: [{ kind: "area", key: "sheikh_zayed" }] }],
    ["Wants 3bed NC", owners[1], { property_types: ["apartment"], places: [{ kind: "area", key: "new_cairo" }], bedrooms_min: 3, bedrooms_max: 4, price_max: 12_000_000 }],
    ["Wants 2bed NC", owners[0], { property_types: ["apartment"], places: [{ kind: "area", key: "new_cairo" }], bedrooms_min: 2, bedrooms_max: 2, price_max: 3_000_000 }],
    ["Wants luxury NC", owners[1], { property_types: ["apartment"], places: [{ kind: "area", key: "new_cairo" }], price_min: 12_000_000 }],
    ["Wants cheap NC", owners[0], { property_types: ["apartment"], places: [{ kind: "area", key: "new_cairo" }], price_max: 1_000 }]
  ];
  for (const [name, to, filters] of wants) {
    const w = await lead(name, { to, stage: "contacted", contacted: true, ageH: 30 });
    const r = await LeadRequests.saveRequest(pool, a.manager, w.id, filters);
    if (r.error) throw new Error(`QA request "${name}": ${r.error}`);
  }
  return { removed, leads: ids.length, units: units.length, deals: d, teamLead: !!a.teamLead };
}

async function main() {
  const { createPool } = require("../lib/db");
  const { agencyOf } = require("./seed-ask");
  const args = process.argv.slice(2);
  if (args[0] !== "seed") return console.log("Usage: seed-assistant-qa.js seed [--agency <id>]");
  if (!/(localhost|127\.0\.0\.1)/.test(process.env.DATABASE_URL || "")) throw new Error("Refusing to seed: DATABASE_URL is not localhost.");
  const pool = createPool();
  try {
    console.log(JSON.stringify(await seed(pool, await agencyOf(pool, args)), null, 2));
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

module.exports = { seed, cleanOwned };
