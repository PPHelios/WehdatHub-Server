// lib/readCaps.js — Daily and per-minute caps on what one signed-in person can read, so a stolen or misused sign-in
// cannot copy owner phones, leads or the unit list in bulk. Every owner phone view is logged; the first time someone
// hits a cap, the CRM owner is alerted on Telegram.
"use strict";

const RateLimit = require("./rateLimit");
const Authz = require("./authz");
const ErrorReports = require("./errorReports");
const { logOperation } = require("./db");

const DAY = 86400;
// Owner phones a person may see per day (a list page counts one per owner shown).
const PHONE_CAP = { broker: 50, manager: 150, owner: 300 };
// Rows of a list (units, leads) a person may read per day.
const LIST_CAP = { broker: 1500, manager: 5000, owner: 8000 };
// A broker cannot page deeper than this into a list; managers and agency owners can.
const BROKER_MAX_OFFSET = 200;

const tier = (b) => (Authz.isAgencyOwner(b) ? "owner" : Authz.isManager(b) ? "manager" : "broker");

async function alertFirst(broker, what, limit, hits, cost) {
  if (hits - cost > limit) return; // already alerted on an earlier call
  ErrorReports.alertOwner([`⚠️ Read cap hit: ${what}`, `${broker.name || "?"} (${broker.role || "?"}) · limit ${limit}/day`].join("\n")).catch(() => {});
}

/**
 * Counts n owner phones seen by this person today. Returns { allowed } and logs every allowed view (who, how many, where).
 * @param {{channel?: string, ref?: string}} [meta]
 */
async function takeOwnerPhones(pool, broker, n, meta = {}) {
  if (!n) return { allowed: true };
  // QA round 4 #3/#59: opening the same owner's page again today (refresh, Back, a second visit) shows the same phones, so it
  // costs nothing more; the view is still logged. Only a first look today counts against the daily cap.
  const seenBucket = meta.once ? `owner_seen:${broker.id}:${meta.once}` : null;
  if (seenBucket && (await seenToday(pool, seenBucket))) {
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "owner_phone_view", status: "success", metadata: { channel: meta.channel || null, count: 0, repeat: true, ref: meta.ref || null } });
    return { allowed: true };
  }
  const limit = PHONE_CAP[tier(broker)];
  const gate = await RateLimit.hit(pool, `owner_phones:broker:${broker.id}`, { limit, windowSec: DAY, cost: n });
  if (!gate.allowed) {
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "owner_phone_cap", status: "failed", metadata: { channel: meta.channel || null, n } });
    await alertFirst(broker, "owner phones", limit, gate.hits, n);
    return { allowed: false, retryAfterSec: gate.retryAfterSec };
  }
  if (seenBucket) await RateLimit.hit(pool, seenBucket, { limit: 1, windowSec: DAY }).catch(() => {});
  logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "owner_phone_view", status: "success", metadata: { channel: meta.channel || null, count: n, ref: meta.ref || null } });
  return { allowed: true };
}

/** Whether this bucket was already marked in today's window (same day window as RateLimit.hit). */
async function seenToday(pool, bucket) {
  const start = new Date(Math.floor(Date.now() / (DAY * 1000)) * DAY * 1000).toISOString();
  const { rows } = await pool.query("SELECT 1 FROM web_rate_limits WHERE bucket = $1 AND window_start = $2", [bucket, start]);
  return rows.length > 0;
}

/** Counts n list rows (kind: "units" or "leads") read today. Returns { allowed }. */
async function takeListRows(pool, broker, kind, n) {
  if (!n) return { allowed: true };
  const limit = LIST_CAP[tier(broker)];
  const gate = await RateLimit.hit(pool, `list_rows:${kind}:broker:${broker.id}`, { limit, windowSec: DAY, cost: n });
  if (!gate.allowed) {
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "list_cap", status: "failed", metadata: { kind, n } });
    await alertFirst(broker, `${kind} list`, limit, gate.hits, n);
    return { allowed: false, retryAfterSec: gate.retryAfterSec };
  }
  return { allowed: true };
}

/** The deepest offset this person may ask for in a list. */
const maxOffset = (broker, hard) => (tier(broker) === "broker" ? Math.min(BROKER_MAX_OFFSET, hard) : hard);

/** App API: a per-minute cap on every signed-in read, per person. */
function apiReadLimiter(pool) {
  return async (req, res, next) => {
    if (req.method !== "GET" || !req.session?.broker) return next();
    const gate = await RateLimit.hit(pool, `api_read:broker:${req.session.broker.id}`, RateLimit.LIMITS.apiReadBroker).catch(() => ({ allowed: true }));
    if (gate.allowed) return next();
    return res.set("Retry-After", String(gate.retryAfterSec)).status(429).json({ error: "rate_limited" });
  };
}

module.exports = { takeOwnerPhones, takeListRows, maxOffset, apiReadLimiter, PHONE_CAP, LIST_CAP, BROKER_MAX_OFFSET };
