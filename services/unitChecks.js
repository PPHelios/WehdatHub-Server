// services/unitChecks.js — "Still available?" (6.3). Units nobody has vouched for in 21 days (confirmed_at, set by every
// insert, edit and quick update) get one question to their broker: one unit carries [✅ Still available] [💰 Sold]
// [🗄️ Archive] (the quick-update buttons), several get a grouped message with [🔎 Review] that lists them, each opening
// the quick menu. A unit's status never changes by itself: only the person (an edit, or the buttons on the question) moves it,
// and Today lists the units still waiting for an answer. Asking happens 10:00–19:59 Cairo; claims use FOR UPDATE
// SKIP LOCKED so two instances never ask twice. Developer models (price lists) are not checked.
"use strict";

const crypto = require("crypto");
const Notifications = require("../lib/notifications");
const Describe = require("../domain/describe");
const { withTransaction } = require("../lib/db");
const Vis = require("../lib/visibility");

const ASK_AFTER_DAYS = 21;
const ASK_HOURS = [10, 20];
const BATCH = 300;
const LINES = 5;
const DAY = 24 * 3600 * 1000;
const BROKER_COLS = "id, agency_id, name, role, is_active, preferred_lang, phone_number, phone_normalized, notify_prefs";

const en = (b) => b?.preferred_lang === "en";
const L = (b, ar, eng) => (en(b) ? eng : ar);
const VOUCHED = "COALESCE(confirmed_at, updated_at, created_at)";
const cairoHour = (now) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", hourCycle: "h23" }).format(now)) % 24;
const dedupe = (prefix, units, now) =>
  `${prefix}:${crypto.createHash("sha1").update(`${now.toISOString().slice(0, 10)}|${units.map((u) => u.id).sort().join(",")}`).digest("hex").slice(0, 20)}`;

/** One unit's line: "• NH-V12 · شقة 150م · Mivida". */
const unitLine = (u, b) => `• ${u.code} · ${Describe.compactLine(u, en(b) ? "en" : "ar")}`;

function askMessage(broker, units) {
  if (units.length === 1) {
    const u = units[0];
    return {
      title: L(broker, `🤔 ${u.code} لسه متاحة؟`, `🤔 Is ${u.code} still available?`),
      body: [Describe.compactLine(u, en(broker) ? "en" : "ar"), L(broker, `محدش أكدها من ${ASK_AFTER_DAYS} يوم.`, `Nobody has confirmed it in ${ASK_AFTER_DAYS} days.`)].join("\n"),
      url: `/app/units/${encodeURIComponent(u.code)}`,
      listingId: u.id,
      buttons: [
        { id: `qu:available:${u.code}`, title: L(broker, "✅ لسه متاحة", "✅ Still available") },
        { id: `qu:sold:${u.code}`, title: L(broker, "💰 اتباعت", "💰 Sold") },
        { id: `qu:archive:${u.code}`, title: L(broker, "🗄️ أرشفة", "🗄️ Archive") }
      ]
    };
  }
  const lines = units.slice(0, LINES).map((u) => unitLine(u, broker));
  if (units.length > LINES) lines.push(L(broker, `…و${units.length - LINES} كمان`, `…and ${units.length - LINES} more`));
  return {
    title: L(broker, `🤔 ${units.length} وحدات محدش أكدها من ${ASK_AFTER_DAYS} يوم، لسه متاحة؟`, `🤔 ${units.length} units unconfirmed for ${ASK_AFTER_DAYS} days: still available?`),
    body: lines.join("\n"),
    url: "/app/units",
    buttons: [{ id: "uc:review", title: L(broker, "🔎 راجعهم", "🔎 Review") }]
  };
}

async function tell(pool, units, kind, build, prefix, now) {
  const byBroker = new Map();
  for (const u of units) {
    if (!u.broker_id) continue;
    if (!byBroker.has(u.broker_id)) byBroker.set(u.broker_id, []);
    byBroker.get(u.broker_id).push(u);
  }
  let told = 0;
  for (const [brokerId, list] of byBroker) {
    const { rows } = await pool.query(`SELECT ${BROKER_COLS} FROM brokers WHERE id = $1 AND agency_id = $2`, [brokerId, list[0].agency_id]);
    const broker = rows[0];
    if (!broker || !broker.is_active) continue;
    await Notifications.notifyBroker(pool, broker, { kind, dedupeKey: dedupe(prefix, list, now), ...build(broker, list), now });
    told++;
  }
  return told;
}

/** Asks about units unconfirmed for 21 days (once per confirmation). → { asked, brokers } */
async function askStale(pool, { now = new Date(), limit = BATCH } = {}) {
  if (cairoHour(now) < ASK_HOURS[0] || cairoHour(now) >= ASK_HOURS[1]) return { asked: 0, brokers: 0, skipped: true };
  const units = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT id FROM listings
        WHERE ${Vis.units("listings")} AND status = 'active' AND inventory_type IS DISTINCT FROM 'developer_model' AND broker_id IS NOT NULL
          AND ${VOUCHED} < $1 AND (stale_asked_at IS NULL OR stale_asked_at < ${VOUCHED})
        ORDER BY ${VOUCHED}, id LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [new Date(now.getTime() - ASK_AFTER_DAYS * DAY).toISOString(), limit]
    );
    if (!rows.length) return [];
    // A stamp, not an edit: version and confirmed_at stay.
    const upd = await client.query("UPDATE listings SET stale_asked_at = $2 WHERE id = ANY($1::uuid[]) RETURNING *", [rows.map((r) => r.id), now.toISOString()]);
    return upd.rows.sort((a, b) => String(a.code).localeCompare(String(b.code)));
  });
  if (!units.length) return { asked: 0, brokers: 0 };
  return { asked: units.length, brokers: await tell(pool, units, "unit_check", askMessage, "uc_ask", now) };
}

/** [🔎 Review]: the broker's units waiting for an answer (asked or auto-archived), newest question first. */
async function pendingFor(pool, broker, { limit = 10 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM listings
      WHERE ${Vis.units("listings")} AND agency_id = $1 AND broker_id = $2 AND stale_asked_at IS NOT NULL AND stale_asked_at >= ${VOUCHED}
        AND (status = 'active' OR (status = 'archived' AND stale_hidden_at IS NOT NULL))
      ORDER BY stale_asked_at DESC, code LIMIT $3`,
    [broker.agency_id, broker.id, limit]
  );
  return rows;
}

/** The scheduler job entry (lib/jobs.js): hourly. */
const unitCheckJob = () => ({
  name: "unit_checks",
  everyMs: 60 * 60 * 1000,
  run: async ({ pool, now }) => {
    const a = await askStale(pool, { now });
    return { counts: { asked: a.asked, brokers: a.brokers } };
  }
});

module.exports = { ASK_AFTER_DAYS, askStale, pendingFor, askMessage, unitCheckJob };
