// lib/channels/telegram.js — Notification channel: a Telegram message to the broker's linked chat (Release 3T).
// Free: no credits and no 24-hour window. Refuses when the broker isn't linked or the Telegram bot is off.
"use strict";

const { notifyTelegram } = require("../dispatcher");
const { textOf } = require("./text");

const name = "telegram";

/** A failure worth another try: Telegram's rate limit (429), its own errors (5xx), or no answer at all (network, timeout). */
function retryableError(err) {
  if (err?.code === "TG_NOT_CONFIGURED") return false;
  const code = Number(err?.code);
  return code === 429 || code >= 500 || !Number.isInteger(code) || code < 100;
}

/**
 * @param {Object} broker
 * @param {Object} message - { kind, title, body, url, buttons }
 * @param {Object} deps - { pool }
 * @returns {Promise<{ ok: boolean, id?: string, error?: string, retryable?: boolean, retryAfter?: number|null }>}
 *   error: "not_linked" (nothing to send to) | "dropped" (nothing sent, no error) | "tg_<code>" (Telegram refused or was unreachable)
 */
async function send(broker, message, { pool }) {
  const outcome = {};
  const r = await notifyTelegram(broker, textOf(message), { pool, kind: `notify_${message.kind}`, buttons: message.buttons || null, outcome });
  if (r) return { ok: true, id: String(r.message_id || "") };
  if (outcome.error) {
    const code = outcome.error.code;
    return { ok: false, error: `tg_${Number.isInteger(Number(code)) && code ? code : "network"}`, retryable: retryableError(outcome.error), retryAfter: outcome.error.retryAfter || null };
  }
  return { ok: false, error: "not_linked" };
}

module.exports = { name, send, retryableError };
