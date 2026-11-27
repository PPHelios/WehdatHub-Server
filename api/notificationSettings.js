// api/notificationSettings.js — The app's Notifications screen reads and saves the same choices as the website's Settings:
// channel per alert kind, on/off and frequency (where the agency lets the person choose), reminders and quiet hours.
"use strict";

const Notifications = require("../lib/notifications");
const Policy = require("../lib/notificationPolicy");
const Authz = require("../lib/authz");
const { withTransaction } = require("../lib/db");

/** The person's current choices, with the agency's policy applied, in the shape the app shows. */
async function read(pool, broker) {
  const { rows } = await pool.query("SELECT notify_prefs, telegram_chat_id FROM brokers WHERE id = $1 AND agency_id = $2", [broker.id, broker.agency_id]);
  const me = { ...broker, notify_prefs: rows[0]?.notify_prefs || {}, telegram_chat_id: rows[0]?.telegram_chat_id || null };
  const prefs = Notifications.prefsOf(me, { telegramLinked: Boolean(me.telegram_chat_id) });
  const kinds = Notifications.kindsFor(broker);
  const items = {};
  const policy = Policy.policyOf((await pool.query("SELECT notify_policy FROM agencies WHERE id = $1", [broker.agency_id])).rows[0]);
  for (const k of kinds) {
    const eff = Notifications.effectiveFrom(policy, me, k);
    items[k] = { label: { ar: Notifications.KIND_LABELS[k][0], en: Notifications.KIND_LABELS[k][1] }, on: eff.enabled !== false, channel: eff.channel || prefs.channels[k], frequency: eff.frequency || "immediate", locked: eff.locked || null, urgent: Policy.isUrgent(k) };
  }
  return {
    kinds: items, reminderMinutes: prefs.reminderMinutes, quiet: prefs.quiet, telegramLinked: Boolean(me.telegram_chat_id),
    ...(Authz.isManager(broker) ? { agencyUnitChecks: { enabled: policy.unit_check?.on !== false, locked: !Policy.mayChange(broker, policy.unit_check) } } : {})
  };
}

function register(api, { pool }) {
  api.get("/notification-settings", async (req, res) => {
    return res.json(await read(pool, req.session.broker));
  });

  api.put("/notification-settings", async (req, res) => {
    const { broker } = req.session;
    const body = req.body || {};
    const agencyUnitChecks = body.agencyUnitChecks;
    if (agencyUnitChecks !== undefined) {
      if (!Authz.isManager(broker)) return res.status(403).json({ error: "forbidden" });
      if (typeof agencyUnitChecks !== "boolean") return res.status(400).json({ error: "invalid_setting" });
    }
    const kinds = Notifications.kindsFor(broker);
    const channels = {};
    const on = {};
    const frequency = {};
    const given = body.kinds && typeof body.kinds === "object" ? body.kinds : {};
    for (const k of kinds) {
      const row = given[k];
      if (!row || typeof row !== "object") continue;
      if (Notifications.CHANNELS.includes(row.channel)) channels[k] = row.channel;
      if (typeof row.on === "boolean") on[k] = row.on;
      if (Policy.FREQUENCIES.includes(row.frequency)) frequency[k] = row.frequency;
    }
    const quiet = body.quiet && typeof body.quiet === "object" ? body.quiet : {};
    const saved = await withTransaction(pool, async (client) => {
      if (agencyUnitChecks !== undefined) {
        const updated = await client.query(
          `UPDATE agencies SET notify_policy = jsonb_set(COALESCE(notify_policy, '{}'::jsonb), '{unit_check}',
             COALESCE(notify_policy->'unit_check', '{}'::jsonb) || jsonb_build_object('on', $2::boolean))
           WHERE id = $1 AND ($3::boolean OR notify_policy->'unit_check'->>'lock' IS DISTINCT FROM 'owner')`,
          [broker.agency_id, agencyUnitChecks, Authz.isAgencyOwner(broker)]
        );
        if (!updated.rowCount) return false;
      }
      const { rows } = await client.query("SELECT notify_prefs, telegram_chat_id FROM brokers WHERE id = $1 AND agency_id = $2 FOR UPDATE", [broker.id, broker.agency_id]);
      await Notifications.savePrefs(client, { ...broker, notify_prefs: rows[0]?.notify_prefs || {}, telegram_chat_id: rows[0]?.telegram_chat_id || null }, {
        channels,
        on,
        frequency,
        quiet: { enabled: quiet.enabled === true, start: quiet.start, end: quiet.end },
        reminderMinutes: Array.isArray(body.reminderMinutes) ? body.reminderMinutes.map(Number) : undefined
      });
      return true;
    });
    if (!saved) return res.status(403).json({ error: "owner_locked" });
    return res.json(await read(pool, broker));
  });
}

module.exports = { register };
