// services/agencyCreate.js — The CRM owner adds an agency by hand (owner page, /app/owner). One transaction creates the
// agency (name, logo URL, slug, plan) and its owner (an active `owner` broker with the mobile given). The result carries
// the owner's one-time Telegram start link (7 days); nothing is sent to anyone: the CRM owner sends it. The owner taps
// it, then opens the website from the bot. Plan: `pilot` (free Office until the POC ends), `pilot14` (a guided 14-day multi-seat
// pilot: Office with paid_until = now + 14 days, so it walks the normal expiry ladder; the open-ended `pilot` flag is untouched)
// or `trial` (14 days: 1 seat, 50 units, 80 AI credits). `demoId` links the agency to the demo request it came from.
"use strict";

const crypto = require("crypto");
const Phone = require("../domain/phone");
const Plans = require("../domain/plans");
const Slug = require("../domain/slug");
const TgLink = require("../lib/tgLink");
const { withTransaction } = require("../lib/db");
const { getConfig } = require("../config");

const DAY = 24 * 3600 * 1000;
const PLANS = ["pilot", "trial", "pilot14"];
const PILOT_DAYS = 14;

/** https only, at most 500 characters; "" means no logo. Returns null when the value is not allowed. */
function cleanLogo(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.length > 500 || !/^https:\/\/[^\s]+$/i.test(s)) return null;
  return s;
}

/** A slug nobody has yet: the name's slug, then -2, -3 … (the name's own slug is reserved for it first). */
async function freeSlug(client, name, id) {
  const base = Slug.baseSlug(name, id);
  for (let i = 1; i <= 50; i++) {
    const candidate = i === 1 ? base : `${base.slice(0, 40)}-${i}`;
    const { rows } = await client.query("SELECT 1 FROM agencies WHERE slug = $1", [candidate]);
    if (!rows.length) return candidate;
  }
  return null;
}

/**
 * Creates an agency and its owner. Only the CRM owner may call it (the route checks; this checks again).
 * @param {Object} input - { agency, logo, ownerName, ownerPhone, plan: "pilot"|"trial"|"pilot14", demoId? }
 * @returns {Promise<{ ok, agency, broker, url } | { error: forbidden|agency|logo|name|phone|plan|phone_taken|slug|demo }>}
 */
async function createAgency(pool, actor, input = {}, { now = new Date(), username = getConfig().telegram.botUsername, issueToken = TgLink.issueLinkToken } = {}) {
  const owners = getConfig().owner.brokerIds;
  if (!actor || !owners.includes(String(actor.id || "").toLowerCase())) return { error: "forbidden" };
  const name = String(input.agency || "").trim().slice(0, 120);
  const ownerName = String(input.ownerName || "").trim().slice(0, 80);
  const digits = Phone.normalizePhone(input.ownerPhone);
  const logo = cleanLogo(input.logo);
  const plan = PLANS.includes(input.plan) ? input.plan : null;
  if (!name) return { error: "agency" };
  if (logo === null) return { error: "logo" };
  if (!ownerName) return { error: "name" };
  if (!digits || !Phone.isEgyptMobile(digits)) return { error: "phone" };
  if (!plan) return { error: "plan" };

  const res = await withTransaction(pool, async (client) => {
    const { rows: taken } = await client.query("SELECT 1 FROM brokers WHERE phone_normalized = $1", [digits]);
    if (taken.length) return { error: "phone_taken" };
    const agencyId = crypto.randomUUID();
    const slug = await freeSlug(client, name, agencyId);
    if (!slug) return { error: "slug" };
    if (input.demoId !== undefined && input.demoId !== null) {
      const { rows: d } = await client.query("SELECT 1 FROM demo_requests WHERE id = $1 AND kind = 'demo' AND pilot_agency_id IS NULL FOR UPDATE", [input.demoId]);
      if (!d.length) return { error: "demo" };
    }
    const trialEnds = plan === "trial" ? new Date(now.getTime() + Plans.TRIAL.days * DAY).toISOString() : null;
    const paidUntil = plan === "pilot14" ? new Date(now.getTime() + PILOT_DAYS * DAY).toISOString() : null;
    const { rows: a } = await client.query(
      `INSERT INTO agencies (id, name, slug, logo_url, plan, pilot, approval, trial_ends_at, paid_until, signed_up_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'approved', $7, $8, $9) RETURNING id, name, slug, logo_url, plan, pilot, trial_ends_at, paid_until`,
      [agencyId, name, slug, logo || null, plan === "trial" ? Plans.TRIAL.plan : "office", plan === "pilot", trialEnds, paidUntil, now.toISOString()]
    );
    if (input.demoId !== undefined && input.demoId !== null) await client.query("UPDATE demo_requests SET pilot_agency_id = $2 WHERE id = $1", [input.demoId, agencyId]);
    const { rows: b } = await client.query(
      `INSERT INTO brokers (agency_id, phone_number, name, role, preferred_lang, is_active)
       VALUES ($1, $2, $3, 'owner', 'ar', true) RETURNING id, agency_id, name, phone_number, preferred_lang, role`,
      [agencyId, digits, ownerName]
    );
    return { ok: true, agency: a[0], broker: b[0] };
  });
  if (!res.ok) return res;
  const url = TgLink.startLink(username, "x") ? TgLink.startLink(username, await issueToken(pool, res.broker)) : null;
  return { ...res, url };
}

module.exports = { createAgency, cleanLogo, PLANS, PILOT_DAYS };
