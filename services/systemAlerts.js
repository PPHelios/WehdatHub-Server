// services/systemAlerts.js — Alerts for the CRM owner (the product owner, OWNER_BROKER_IDS) about the app itself: an
// error spike, AI calls failing, an agency near the end of its credits, a payment waiting for a day. Each check runs
// hourly and notifies only the CRM owner, through the notification centre (kind "system_alert": Telegram, push or inbox,
// as chosen in their settings). The same alert is not sent again within a cooldown (the dedupe key carries the window).
// Numbers are settings (SYSTEM_ALERT_* environment variables) with the defaults below.
"use strict";

const Notifications = require("../lib/notifications");
const Credits = require("./credits");
const { getConfig } = require("../config");

const HOUR = 3600 * 1000;
const num = (name, d) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : d);

/** The thresholds, read each run so a changed setting applies without a restart. */
function limits() {
  return {
    errorsPerHour: num("SYSTEM_ALERT_ERRORS_PER_HOUR", 20), // at least this many errors in an hour …
    errorMultiple: num("SYSTEM_ALERT_ERROR_MULTIPLE", 3), // … and this many times the same hour's average of the last 7 days
    aiFailPct: num("SYSTEM_ALERT_AI_FAIL_PCT", 25),
    aiMinCalls: num("SYSTEM_ALERT_AI_MIN_CALLS", 10),
    quotaPct: num("SYSTEM_ALERT_QUOTA_PCT", 90),
    paymentHours: num("SYSTEM_ALERT_PAYMENT_HOURS", 24),
    cooldownHours: num("SYSTEM_ALERT_COOLDOWN_HOURS", 6)
  };
}

/** The alerts that are due now: [{ key, title, body }] (key is stable per condition, so a cooldown can dedupe it). */
async function due(pool, { now = new Date() } = {}) {
  const lim = limits();
  const out = [];
  const since = (ms) => new Date(now.getTime() - ms).toISOString();

  // 1. Error spike: this hour against the average hour of the previous 7 days.
  const [e] = (await pool.query(
    `SELECT count(*) FILTER (WHERE created_at >= $1)::int AS last_hour,
            count(*) FILTER (WHERE created_at < $1 AND created_at >= $2)::int AS before
       FROM error_events WHERE kind = 'error' AND created_at >= $2`,
    [since(HOUR), since(7 * 24 * HOUR)]
  )).rows;
  const avg = e.before / (7 * 24 - 1);
  if (e.last_hour >= lim.errorsPerHour && e.last_hour >= lim.errorMultiple * avg) {
    out.push({
      key: "errors",
      title: `🚨 ${e.last_hour} errors in the last hour (usually ${Math.round(avg * 10) / 10} an hour)`,
      body: "Open the board's Operations tab."
    });
  }

  // 2. AI calls failing.
  const [a] = (await pool.query(
    `SELECT count(*)::int AS calls, count(*) FILTER (WHERE status = 'failed')::int AS failed
       FROM operation_logs WHERE created_at >= $1 AND model_used IS NOT NULL`,
    [since(HOUR)]
  )).rows;
  if (a.calls >= lim.aiMinCalls && (100 * a.failed) / a.calls >= lim.aiFailPct) {
    out.push({ key: "ai_failures", title: `🤖 ${a.failed} of ${a.calls} AI calls failed in the last hour`, body: "Open the board's AI tab." });
  }

  // 3. An agency near the end of its monthly credits.
  const { rows: agencies } = await pool.query("SELECT id, name, plan FROM agencies");
  for (const ag of agencies) {
    const total = (await Credits.poolFor(pool, ag.id, ag.plan, { now })).total;
    if (!(total > 0)) continue;
    const used = await Credits.usedThisMonth(pool, ag.id, { now });
    const pct = Math.round((100 * used) / total);
    if (pct >= lim.quotaPct) out.push({ key: `quota:${ag.id}`, title: `📈 ${ag.name} has used ${pct}% of this month's credits`, body: `${used} of ${total}.` });
  }

  // 4. A payment waiting for too long.
  const { rows: pay } = await pool.query(
    `SELECT p.id, a.name FROM payments p JOIN agencies a ON a.id = p.agency_id
      WHERE p.status = 'pending' AND p.created_at < $1 ORDER BY p.created_at LIMIT 10`,
    [since(lim.paymentHours * HOUR)]
  );
  for (const p of pay) out.push({ key: `payment:${p.id}`, title: `💳 A payment from ${p.name} has waited over ${lim.paymentHours} hours`, body: "Confirm or cancel it on the board." });
  return out;
}

/** The brokers who are the CRM owner (OWNER_BROKER_IDS) and still active. */
async function recipients(pool) {
  const ids = getConfig().owner.brokerIds;
  if (!ids.length) return [];
  const { rows } = await pool.query(
    "SELECT id, agency_id, name, role, is_active, preferred_lang, phone_number, phone_normalized, notify_prefs, telegram_chat_id FROM brokers WHERE id = ANY($1::uuid[]) AND is_active",
    [ids]
  );
  return rows;
}

/** Runs the checks and notifies the CRM owner once per condition per cooldown window. → { alerts, sent } */
async function run(pool, { now = new Date() } = {}) {
  const list = await recipients(pool);
  if (!list.length) return { alerts: 0, sent: 0 };
  const alerts = await due(pool, { now });
  const lim = limits();
  const window = Math.floor(now.getTime() / (lim.cooldownHours * HOUR));
  let sent = 0;
  for (const alert of alerts) {
    for (const owner of list) {
      const r = await Notifications.notifyBroker(pool, owner, {
        kind: "system_alert",
        dedupeKey: `system:${alert.key}:${window}`,
        title: alert.title,
        body: alert.body,
        url: "/app/owner/board",
        now
      }).catch((err) => {
        console.warn("System alert failed:", err.message);
        return null;
      });
      if (r && !r.duplicate) sent += 1;
    }
  }
  return { alerts: alerts.length, sent };
}

const alertJob = () => ({ name: "system_alerts", everyMs: HOUR, run: ({ pool, now }) => run(pool, { now }).then((counts) => ({ counts })) });

module.exports = { limits, due, recipients, run, alertJob };
