// lib/requestIds.js — One-time request IDs: a create/change request carries an ID made by the page (hidden _rid field or
// X-Request-Id header). If the same ID arrives again within two minutes (a double tap, a network retry, the browser re-sending
// a form), the repeat is not run; the person is sent back to where they were. Kept in memory: one instance runs the web app.
"use strict";

const TTL_MS = 2 * 60 * 1000;
const MAX_KEYS = 20000;
const seen = new Map(); // "<broker>:<id>" → time first seen

function sweep(now) {
  for (const [k, t] of seen) if (now - t > TTL_MS) seen.delete(k);
  if (seen.size > MAX_KEYS) for (const k of seen.keys()) { seen.delete(k); if (seen.size <= MAX_KEYS / 2) break; }
}

/** True if this ID (for this person) was already used; otherwise remembers it and returns false. */
function repeated(brokerId, id, now = Date.now()) {
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(String(id))) return false;
  const key = `${brokerId || "-"}:${id}`;
  const t = seen.get(key);
  if (t && now - t <= TTL_MS) return true;
  if (seen.size >= MAX_KEYS / 2) sweep(now);
  seen.set(key, now);
  return false;
}

/** Express middleware for change requests: a repeated ID is answered without running the handler. */
function middleware(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const id = req.get("x-request-id") || (req.body && req.body._rid);
  if (!repeated(req.session?.broker?.id, id)) return next();
  if (req.get("hx-request")) return res.status(204).set("HX-Reswap", "none").end();
  let back = "/app/";
  try {
    const ref = new URL(req.get("referer") || "", "http://x");
    if (ref.pathname.startsWith("/app")) back = ref.pathname + ref.search;
  } catch { /* keep the default */ }
  return res.redirect(303, back);
}

function reset() { seen.clear(); }

module.exports = { TTL_MS, repeated, middleware, reset };
