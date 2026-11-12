// lib/usageLog.js — Feature-adoption and timing events. The phone sends batches (POST /usage-events); the server also times
// its own calls for the app (middleware below), so numbers exist for every app version. Never stores names, phones or text.
"use strict";

const APP_EVENTS = new Set(["ask", "search", "voice_search", "open_unit", "flyer_make", "flyer_save", "flyer_share", "client_link", "call_tap", "whatsapp_tap", "lead_assign", "lead_paste", "unit_save", "photo_upload", "screen_slow"]);
const META_KEYS = ["screen", "count", "wait_ms", "kind", "bytes", "retry", "app_version", "platform"];
const MAX_BATCH = 20;

function cleanMeta(m) {
  if (!m || typeof m !== "object") return null;
  const out = {};
  for (const k of META_KEYS) {
    const v = m[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 40);
  }
  return Object.keys(out).length ? out : null;
}

/** Valid events from a request body: allowlisted names only, at most 20, ms as a whole number 0..600000. */
function cleanBatch(body) {
  const list = Array.isArray(body && body.events) ? body.events.slice(0, MAX_BATCH) : [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e.event !== "string" || !APP_EVENTS.has(e.event)) continue;
    const ms = Number.isFinite(e.ms) ? Math.min(600000, Math.max(0, Math.round(e.ms))) : null;
    out.push({ event: e.event, ok: e.ok !== false, ms, meta: cleanMeta(e.meta) });
  }
  return out;
}

async function record(pool, { agencyId, brokerId, channel, events }) {
  if (!events.length) return 0;
  const vals = [];
  const args = [];
  events.forEach((e, i) => {
    const b = i * 7;
    vals.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}::jsonb)`);
    args.push(agencyId || null, brokerId || null, channel, e.event, e.ok, e.ms, e.meta ? JSON.stringify(e.meta) : null);
  });
  await pool.query(`INSERT INTO usage_events (agency_id, broker_id, channel, event, ok, ms, meta) VALUES ${vals.join(",")}`, args);
  return events.length;
}

// Server-side timing of the calls the app depends on: [method, path pattern, event name].
const TIMED = [
  ["GET", /^\/search$/, "server_search"],
  ["POST", /^\/ask$/, "server_ask"],
  ["POST", /^\/units\/[^/]+\/flyer/, "server_flyer"],
  ["POST", /^\/units\/[^/]+\/share-link$/, "server_client_link"],
  ["POST", /^\/leads\/extract$/, "server_lead_paste"],
  ["POST", /^\/leads\/[^/]+\/assign$/, "server_lead_assign"],
  ["GET", /^\/units\/[^/]+$/, "server_open_unit"]
];

function track(pool) {
  return (req, res, next) => {
    const hit = TIMED.find(([m, re]) => m === req.method && re.test(req.path));
    if (!hit) return next();
    const t0 = Date.now();
    res.on("finish", () => {
      const b = req.session && req.session.broker;
      if (!b) return;
      record(pool, { agencyId: b.agency_id, brokerId: b.id, channel: "server", events: [{ event: hit[2], ok: res.statusCode < 400, ms: Date.now() - t0, meta: null }] }).catch(() => {});
    });
    next();
  };
}

module.exports = { APP_EVENTS, cleanBatch, record, track };
