// lib/channels/apppush.js — Notification channel: alerts to the mobile app through Firebase Cloud Messaging (HTTP v1).
// The phone's token is saved by POST /api/v1/devices. Like web push, a payload carries a title and a short body with no phone numbers.
"use strict";

const crypto = require("crypto");
const { getConfig } = require("../../config");

const name = "apppush";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
let tokenCache = null;

const b64 = (x) => Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString("base64url");

/** A short-lived Google access token from the service account (signed JWT, RS256). */
async function accessToken(sa, fetchFn = fetch) {
  if (tokenCache && tokenCache.exp > Date.now() + 60000 && tokenCache.email === sa.clientEmail) return tokenCache.token;
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "RS256", typ: "JWT" });
  const claim = b64({ iss: sa.clientEmail, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${claim}`), sa.privateKey).toString("base64url");
  const res = await fetchFn("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error("fcm_auth_failed");
  tokenCache = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000, email: sa.clientEmail };
  return tokenCache.token;
}

/** One message to one phone → { ok } or { gone: true } when Firebase says the token is dead. */
let sender = async (sa, token, payload) => {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.projectId}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken(sa)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { token, notification: { title: payload.title, body: payload.body }, data: payload.data, android: { priority: "high" } } })
  });
  if (res.ok) return { ok: true };
  if (res.status === 404 || res.status === 400) return { gone: true };
  throw new Error(`fcm_${res.status}`);
};

/** Test hook: replace the sender ((serviceAccount, token, payload) → Promise<{ok}|{gone}>). */
function setSenderForTests(fn) {
  tokenCache = null;
  sender = fn;
}

const scrub = (s, max) =>
  String(s || "")
    .replace(/[+\d٠-٩][\d٠-٩\s\-().]{6,}[\d٠-٩]/g, "••")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** What the phone shows, and the screen it opens (a lead ref or unit code only; never a number). */
function payloadOf(message) {
  const p = message.push || {};
  const url = typeof message.url === "string" && message.url.startsWith("/app/") ? message.url : "/app/notifications";
  return { title: scrub(p.title || message.title, 80), body: scrub(p.body ?? "", 140), data: { url } };
}

/**
 * @param {Object} broker
 * @param {Object} message - { title, body, url, push: { title, body } }
 * @param {Object} deps - { pool }
 * @returns {Promise<{ ok: boolean, sent?: number, error?: string }>}
 */
async function send(broker, message, { pool }) {
  const sa = getConfig().appPush.serviceAccount;
  if (!sa) return { ok: false, error: "not_configured" };
  const { rows } = await pool.query("SELECT id, token FROM device_tokens WHERE broker_id = $1 AND agency_id = $2 ORDER BY id", [broker.id, broker.agency_id]);
  if (!rows.length) return { ok: false, error: "no_device" };
  const payload = payloadOf(message);
  let sent = 0;
  for (const d of rows) {
    try {
      const r = await sender(sa, d.token, payload);
      if (r.gone) await pool.query("DELETE FROM device_tokens WHERE id = $1", [d.id]);
      else {
        sent++;
        await pool.query("UPDATE device_tokens SET last_ok_at = NOW(), failed_count = 0 WHERE id = $1", [d.id]);
      }
    } catch {
      await pool.query("UPDATE device_tokens SET failed_count = failed_count + 1 WHERE id = $1", [d.id]);
    }
  }
  return sent ? { ok: true, sent } : { ok: false, error: "send_failed" };
}

module.exports = { name, send, payloadOf, setSenderForTests };
