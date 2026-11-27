// tests/harness/assistantDataset.js — A fixed CRM dataset (known counts per queue, window, broker, team) for the assistant accuracy tests.
// Every expected number in tests/api/assistant-accuracy.test.js comes from the `leads` / `deals` / `leases` specs below, never from the services.
"use strict";

const Viewings = require("../../services/viewings");

const HOUR = 3600 * 1000;
const MIN = 60 * 1000;
const ID = (n) => `30000000-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;

/** Extra brokers: two teams. TL1 leads B1 + B2, TL2 leads B3. */
const EXTRA = {
  tl1: { id: ID(1), role: "team_lead", name: "Team Lead One", phone: "201000000031" },
  tl2: { id: ID(2), role: "team_lead", name: "Team Lead Two", phone: "201000000032" },
  b3: { id: ID(3), role: "broker", name: "Broker Three", phone: "201000000033" }
};

// ---- Cairo calendar, computed with Intl (independent of the app's own helpers) ----
const ymdOf = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(d);
function cairoOffset(d) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", timeZoneName: "longOffset" }).formatToParts(d).find((x) => x.type === "timeZoneName").value;
  return p === "GMT" ? "+00:00" : p.replace("GMT", "");
}
const midnightOf = (ymd) => {
  const noon = new Date(`${ymd}T12:00:00Z`);
  return new Date(`${ymd}T00:00:00${cairoOffset(noon)}`);
};
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function calendar(now = new Date()) {
  const today = ymdOf(now);
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  const month = today.slice(0, 7);
  const prevMonth01 = `${addDays(`${month}-01`, -1).slice(0, 7)}-01`;
  return {
    today,
    weekStart: addDays(today, -dow),
    monthStart: `${month}-01`,
    prevMonthStart: prevMonth01,
    todayStart: midnightOf(today),
    tomorrowStart: midnightOf(addDays(today, 1)),
    monthStartAt: midnightOf(`${month}-01`)
  };
}

/**
 * Builds the specs. `who`: broker key (broker = B1, colleague = B2, b3) or null (unassigned). `tag`: the queue the lead is seeded for.
 * `at` is the creation time. Time-sensitive leads are relative to now; the rest sit just after the start of this month.
 */
function specs(now = new Date()) {
  const cal = calendar(now);
  const early = new Date(cal.monthStartAt.getTime() + 2 * HOUR); // always inside this month
  const leads = [];
  const lead = (tag, who, n, o = {}) => leads.push({ tag, who, name: `Cl_${tag}_${who || "none"}_${n}`, stage: "contacted", at: early, source: "Website", ...o });
  const n3 = (tag, who, count, o) => { for (let i = 1; i <= count; i++) lead(tag, who, i, o); };

  n3("unas", null, 3, { stage: "new", at: new Date(now - 10 * MIN), source: "Website", contacted: false });
  n3("wait", "broker", 2, { stage: "new", at: new Date(now - 2 * HOUR), source: "Facebook", contacted: false });
  n3("wait", "colleague", 1, { stage: "new", at: new Date(now - 3 * HOUR), source: "Website", contacted: false });
  n3("wait", "b3", 2, { stage: "new", at: new Date(now - 5 * HOUR), source: "Referral", contacted: false });
  n3("appr", "broker", 1, { stage: "new", at: new Date(now - 50 * MIN), source: "Facebook", contacted: false });
  n3("appr", "colleague", 1, { stage: "new", at: new Date(now - 50 * MIN), source: "Website", contacted: false });
  n3("fresh", "broker", 1, { stage: "new", at: new Date(now - 5 * MIN), source: "Referral", contacted: false });
  n3("over", "broker", 2, { fu: { kind: "call", at: new Date(now - 3 * HOUR) }, source: "Facebook" });
  n3("over", "colleague", 1, { fu: { kind: "call", at: new Date(now - 3 * HOUR) }, source: "Referral" });
  n3("over", "b3", 1, { fu: { kind: "call", at: new Date(now - 3 * HOUR) }, source: "Website" });
  // Viewings: end of today (still ahead), tomorrow 10:00 and four days ahead.
  const endToday = new Date(cal.tomorrowStart.getTime() - MIN);
  const day = (n) => new Date(midnightOf(addDays(cal.today, n)).getTime() + 10 * HOUR);
  n3("vtoday", "broker", 1, { stage: "viewing", view: endToday, source: "Facebook" });
  n3("vtoday", "colleague", 1, { stage: "viewing", view: endToday, source: "Facebook" });
  // A booking the client confirmed, and a viewing noted only as a follow-up (no booking). vtoday leads have both a follow-up and a booking: one viewing each.
  n3("vconf", "broker", 1, { stage: "viewing", view: endToday, confirm: true, source: "Referral" });
  n3("vplan", "colleague", 1, { stage: "viewing", fu: { kind: "viewing", at: endToday }, source: "Referral" });
  n3("vtomorrow", "broker", 1, { stage: "viewing", view: day(1), source: "Website" });
  n3("vtomorrow", "b3", 2, { stage: "viewing", view: day(1), source: "Referral" });
  n3("vnext", "colleague", 2, { stage: "viewing", view: day(4), source: "Website" });
  n3("opened", "broker", 1, { link: true });
  n3("opened", "colleague", 1, { link: true });
  n3("opened", "b3", 1, { link: true });
  // Source mix, lost leads, and the window edges (all Facebook, contacted, no follow-up).
  n3("src", "broker", 2, { source: "Facebook" });
  n3("src", "colleague", 1, { source: "Referral" });
  n3("src", "b3", 1, { source: "Facebook" });
  n3("lost", "broker", 1, { stage: "lost", lost: "السعر عالي" });
  n3("lost", "colleague", 1, { stage: "lost", lost: "السعر عالي" });
  n3("lost", "b3", 1, { stage: "lost", lost: "اشترى من مكان تاني" });
  n3("lost", "broker", 1, { stage: "lost", lost: "السعر عالي", n: 2 });
  const minus = (d, m) => new Date(d.getTime() + m * MIN);
  lead("edge2330", "broker", 1, { source: "Facebook", at: minus(cal.todayStart, -30) });
  lead("edge0030", "colleague", 1, { source: "Facebook", at: minus(cal.todayStart, 30) });
  lead("edgeWeekPrev", "broker", 1, { source: "Facebook", at: minus(midnightOf(cal.weekStart), -30) });
  lead("edgeWeekNext", "colleague", 1, { source: "Facebook", at: minus(midnightOf(cal.weekStart), 30) });
  lead("edgeMonthPrev", "broker", 1, { source: "Facebook", at: minus(cal.monthStartAt, -30) });
  lead("edgeMonthNext", "colleague", 1, { source: "Facebook", at: minus(cal.monthStartAt, 30) });
  // Names must stay unique even when a tag repeats for one broker.
  const seen = new Set();
  leads.forEach((l, i) => { while (seen.has(l.name)) l.name += `x${i}`; seen.add(l.name); });

  // Deals: closed_at, market, broker key. 2 + 3 + 2 this month, 1 + 3 + 1 last month.
  const deals = [];
  const deal = (who, market, closed) => deals.push({ who, market, closed, k: deals.length + 1 });
  const thisM = (h) => new Date(cal.monthStartAt.getTime() + h * HOUR);
  deal("broker", "resale", thisM(3)); deal("broker", "resale", thisM(4)); deal("broker", "primary", thisM(5));
  deal("colleague", "resale", thisM(6)); deal("colleague", "resale", thisM(7));
  deal("b3", "primary", thisM(8)); deal("b3", "primary", minus(cal.monthStartAt, 30)); // 00:30 on the 1st
  const lastM = (d) => new Date(cal.monthStartAt.getTime() - d * 24 * HOUR);
  deal("broker", "resale", lastM(2));
  deal("colleague", "primary", lastM(3)); deal("colleague", "primary", lastM(4));
  deal("colleague", "resale", new Date(cal.monthStartAt.getTime() - 30 * MIN)); // 23:30 on the last day of last month
  deal("b3", "primary", lastM(5));
  for (const d of deals) { d.price = 2_000_000 + d.k * 100_000; d.commission = d.k * 10_000; }

  // Leases (end offsets in days from today): two soon, one far, one done, one expired.
  const leases = [{ who: "broker", end: 20 }, { who: "colleague", end: 60 }, { who: "broker", end: 200 }, { who: "colleague", end: 30, done: true }, { who: "broker", end: -10 }];
  return { cal, leads, deals, leases };
}

const keyId = (h, key) => (key === "b3" ? EXTRA.b3.id : h.BROKERS[key].id);

/** Seeds brokers, leads, share links, viewings, deals and leases in agency A. Returns the specs. */
async function seed(h, now = new Date()) {
  const { pool, AGENCY_A } = h;
  await h.seedBroker("manager");
  await h.seedBroker("owner");
  for (const b of Object.values(EXTRA)) {
    await pool.query(
      `INSERT INTO brokers (id, agency_id, phone_number, name, role, is_active, preferred_lang, notify_prefs)
       VALUES ($1, $2, $3, $4, $5, true, 'en', '{"quiet":{"enabled":false}}')`,
      [b.id, AGENCY_A, b.phone, b.name, b.role]
    );
  }
  await pool.query("UPDATE brokers SET team_lead_id = $2 WHERE id = ANY($1::uuid[])", [[h.BROKERS.broker.id, h.BROKERS.colleague.id], EXTRA.tl1.id]);
  await pool.query("UPDATE brokers SET team_lead_id = $2 WHERE id = $1", [EXTRA.b3.id, EXTRA.tl2.id]);

  const S = specs(now);
  const unit = await h.insertListing({ code: "AA-1", market: "resale", compound: "Hyde Park" });
  let ref = 1000;
  for (const l of S.leads) {
    ref += 1;
    l.ref = ref;
    l.phone = `+2010${String(7000000 + ref)}`;
    const assignee = l.who ? keyId(h, l.who) : null;
    const contacted = l.contacted === false ? null : new Date(l.at.getTime() + MIN);
    const { rows } = await pool.query(
      `INSERT INTO leads (agency_id, ref, name, phone_e164, phones, lawful_basis, stage, assigned_broker_id, assigned_at, source, created_at, last_contact_at, lost_reason, last_activity_at)
       VALUES ($1, $2, $3, $4, ARRAY[$4]::text[], 'client_request', $5, $6, $7, $8, $7, $9, $10, $7) RETURNING id`,
      [AGENCY_A, ref, l.name, l.phone, l.stage, assignee, l.at.toISOString(), l.source, contacted && contacted.toISOString(), l.lost || null]
    );
    l.id = rows[0].id;
    if (l.fu) {
      await pool.query("UPDATE leads SET follow_up_status = 'open', follow_up_kind = $2, next_follow_up_at = $3 WHERE id = $1", [l.id, l.fu.kind, l.fu.at.toISOString()]);
    }
    if (l.stage === "lost") {
      await pool.query("INSERT INTO lead_events (agency_id, lead_id, broker_id, kind, data, created_at) VALUES ($1, $2, $3, 'stage', $4, $5)", [AGENCY_A, l.id, assignee, JSON.stringify({ to: "lost" }), l.at.toISOString()]);
    }
    if (l.link) {
      await pool.query(
        `INSERT INTO share_links (token_hash, agency_id, listing_id, broker_id, channel, lead_id, open_count, first_opened_at, last_opened_at)
         VALUES ($1, $2, $3, $4, 'web', $5, 3, now(), now())`,
        [`hash-${ref}`, AGENCY_A, unit.id, assignee, l.id]
      );
    }
    if (l.view) {
      const row = (await pool.query("SELECT * FROM brokers WHERE id = $1", [assignee])).rows[0];
      const r = await Viewings.schedule(pool, row, l.id, { at: l.view, now });
      if (!r.ok) throw new Error(`viewing seed failed: ${r.error}`);
      if (l.confirm) await pool.query("UPDATE viewings SET status = 'confirmed' WHERE id = $1", [r.viewing.id]);
    }
  }

  let dref = 0;
  for (const d of S.deals) {
    dref += 1;
    await pool.query(
      `WITH d AS (
         INSERT INTO deals (agency_id, ref, closing_broker_id, deal_type, price, commission_mode, commission_total, status, closed_at, market)
         VALUES ($1, $2, $3, 'sale', $4, 'amount', $5, 'signed', $6, $7) RETURNING id)
       INSERT INTO deal_splits (deal_id, agency_id, broker_id, pct, amount) SELECT id, $1, $3, 100, $5 FROM d`,
      [AGENCY_A, dref, keyId(h, d.who), d.price, d.commission, d.closed.toISOString(), d.market]
    );
  }

  let lz = 0;
  for (const z of S.leases) {
    lz += 1;
    const u = await h.insertListing({ code: `LZ-${lz}`, market: "resale", listing_type: "rent", compound: "Hyde Park" });
    const [y, m, dd] = S.cal.today.split("-").map(Number);
    const start = new Date(Date.UTC(y, m - 1 - 12, dd + z.end)).toISOString().slice(0, 10);
    await pool.query(
      "INSERT INTO leases (agency_id, listing_id, broker_id, tenant_name, start_date, months, rent, done_at) VALUES ($1, $2, $3, $4, $5, 12, 10000, $6)",
      [AGENCY_A, u.id, keyId(h, z.who), `Tenant ${lz}`, start, z.done ? new Date().toISOString() : null]
    );
  }
  return S;
}

module.exports = { EXTRA, seed, specs, calendar, ymdOf, midnightOf, addDays, keyId };
