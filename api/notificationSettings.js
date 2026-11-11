// api/notificationSettings.js — The app's Notifications screen reads and saves the same choices as the website's Settings:
// channel per alert kind, on/off and frequency (where the agency lets the person choose), reminders and quiet hours.
"use strict";

const Notifications = require("../lib/notifications");
const Policy = require("../lib/notificationPolicy");

/** The person's current choices, with the agency's policy applied, in the shape the app shows. */
async function read(pool, broker) {
  const { rows } = await pool.query("SELECT notify_prefs, telegram_chat_id FROM brokers WHERE id = $1 AND agency_id = $2", [broker.id, broker.agency_id]);
  const me = { ...broker, notify_prefs: rows[0]?.notify_prefs || {}, telegram_chat_id: rows[0]?.telegram_chat_id || null };
  const prefs = Notifications.prefsOf(me, { telegramLinked: Boolean(me.telegram_chat_id) });
  const kinds = Notifications.kindsFor(broker);
  const items = {};
  for (const k of kinds) {
    const eff = await Notifications.effectiveFor(pool, me, k);
    items[k] = { on: eff.on !== false, channel: eff.channel || prefs.channels[k], frequency: eff.frequency || "immediate", locked: eff.locked || null, urgent: Policy.isUrgent(k) };
  }
  return { kinds: items, reminderMinutes: prefs.reminderMinutes, quiet: prefs.quiet, channels: Notifications.CHANNELS };
}

function register(api, { pool }) {
  api.get("/notification-settings", async (req, res) => {
    return res.json(await read(pool, req.session.broker));
  });

  api.put("/notification-settings", async (req, res) => {
    const { broker } = req.session;
    const body = req.body || {};
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
    const { rows } = await pool.query("SELECT notify_prefs, telegram_chat_id, draft_style, quiet_line FROM brokers WHERE id = $1 AND agency_id = $2", [broker.id, broker.agency_id]);
    await Notifications.savePrefs(pool, { ...broker, notify_prefs: rows[0]?.notify_prefs || {}, telegram_chat_id: rows[0]?.telegram_chat_id || null }, {
      channels,
      on,
      frequency,
      quiet: { enabled: quiet.enabled === true, start: quiet.start, end: quiet.end },
      reminderMinutes: Array.isArray(body.reminderMinutes) ? body.reminderMinutes.map(Number) : undefined
    });
    return res.json(await read(pool, broker));
  });
}

module.exports = { register };
