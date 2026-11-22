// services/trialSignup.js — Self-serve trial signup (Phase 5): no owner approval, no card, no SMS provider.
// 1. start(): the website form (agency, name, Egyptian mobile) stores a pending signup (hashed one-time token, 15 minutes)
//    and returns the bot deep link t.me/<bot>?start=su_<token>.
// 2. begin(): the bot's /start su_<token> ties the pending signup to the Telegram account and asks for the contact share.
// 3. verifyContact(): the OTP equivalent. The shared contact must be the sender's own (contact.user_id == from.id) and its
//    number must equal the typed one. Wrong shares count as attempts (5 max). On success one transaction creates the
//    approved agency on the 14-day `trial` plan, its owner broker (linked to that Telegram account) and the trial_claims row.
// One trial per phone AND per Telegram id, ever (trial_claims has a unique index on each; rows outlive the agency).
// Telegram is free, so the "code" is the platform-verified contact: there is no code to send or hash; only the start token
// (hashed, 15 minutes) and the attempt counter (5) guard it.
// Signup stays behind the owner's existing open/closed switch (services/signup.js isOpen).
"use strict";

const crypto = require("crypto");
const Phone = require("../domain/phone");
const Signup = require("./signup");
const Plans = require("../domain/plans");
const TgLink = require("../lib/tgLink");
const Referrals = require("./referrals");
const { withTransaction } = require("../lib/db");
const { getConfig } = require("../config");

const DAY = 24 * 3600 * 1000;
const TOKEN_PREFIX = "su_";
const TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const LIMITS = { ip: { limit: 5, windowSec: 3600 }, phone: { limit: 3, windowSec: 3600 } };
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/** True when a /start payload belongs to a self sign-up (not a broker link token). */
const isSignupToken = (t) => typeof t === "string" && /^su_[A-Za-z0-9_-]{20,60}$/.test(t);

/** Has this phone (digits, 2010...) or Telegram id already used its one trial? */
async function claimed(db, { phone, telegramId }) {
  const e164 = phone ? `+${phone}` : null;
  const { rows } = await db.query("SELECT phone_e164, telegram_id FROM trial_claims WHERE phone_e164 = $1 OR telegram_id = $2 LIMIT 1", [e164, telegramId ?? null]);
  return rows[0] || null;
}

/**
 * Website step. { ok, token, url } or { error: agency|name|phone|referral|phone_taken|trial_used|telegram_off }.
 * @param {Object} input - { agency, name, phone, lang, referral }
 */
async function start(pool, input = {}, { now = new Date(), username = getConfig().telegram.botUsername } = {}) {
  const agencyName = String(input.agency || "").trim().slice(0, 120);
  const name = String(input.name || "").trim().slice(0, 80);
  const digits = Phone.normalizePhone(input.phone);
  const lang = input.lang === "en" ? "en" : "ar";
  const tier = input.tier === "team" ? "team" : "solo";
  const settings = await Signup.trialSettings(pool);
  if (!settings.enabled || !settings.tiers[tier].enabled) return { error: "closed" };
  if (!agencyName) return { error: "agency" };
  if (!name) return { error: "name" };
  if (!digits || !Phone.isEgyptMobile(digits)) return { error: "phone" };
  const referrer = input.referral ? await Referrals.agencyByCode(pool, input.referral) : null;
  if (input.referral && !referrer) return { error: "referral" };
  if (!TgLink.startLink(username, "x")) return { error: "telegram_off" };
  if (await claimed(pool, { phone: digits })) return { error: "trial_used" };
  const { rows: taken } = await pool.query("SELECT 1 FROM brokers WHERE phone_normalized = $1", [digits]);
  if (taken.length) return { error: "phone_taken" };
  const token = TOKEN_PREFIX + crypto.randomBytes(24).toString("base64url");
  await pool.query("DELETE FROM trial_signups WHERE phone_e164 = $1 AND used_at IS NULL", [`+${digits}`]);
  await pool.query(
    `WITH signup AS (
       INSERT INTO trial_signups (token_hash, phone_e164, agency_name, owner_name, lang, referred_by, expires_at, tier)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
     )
     INSERT INTO trial_funnel (signup_id, tier, offered_days, offered_credits, started_at)
     SELECT id, $8, $9, $10, $11 FROM signup`,
    [sha256(token), `+${digits}`, agencyName, name, lang, referrer ? referrer.id : null, new Date(now.getTime() + TTL_MS).toISOString(), tier,
      settings.tiers[tier].days, settings.tiers[tier].credits, now.toISOString()]
  );
  return { ok: true, token, url: TgLink.startLink(username, token), phone: `+${digits}` };
}

/** Bot step 1: /start su_<token>. { ok, signup } or { error: invalid|expired|locked|trial_used|has_account }. */
async function begin(pool, token, ids, { now = new Date() } = {}) {
  if (!isSignupToken(token)) return { error: "invalid" };
  const { rows } = await pool.query("SELECT * FROM trial_signups WHERE token_hash = $1 AND used_at IS NULL", [sha256(token)]);
  const s = rows[0];
  if (!s) return { error: "invalid" };
  if (new Date(s.expires_at) <= now) return { error: "expired" };
  if (s.attempts >= MAX_ATTEMPTS) return { error: "locked" };
  if (await claimed(pool, { telegramId: ids.userId })) return { error: "trial_used" };
  if (await TgLink.findBroker(pool, ids.userId)) return { error: "has_account" };
  await pool.query(
    `WITH signup AS (
       UPDATE trial_signups SET telegram_id = $2, chat_id = $3 WHERE id = $1 AND used_at IS NULL RETURNING id
     )
     UPDATE trial_funnel SET telegram_opened_at = COALESCE(telegram_opened_at, $4)
     WHERE signup_id = (SELECT id FROM signup)`,
    [s.id, ids.userId, ids.chatId, now.toISOString()]
  );
  return { ok: true, signup: s };
}

/** The open signup a Telegram user started (null when none): the next contact share belongs to it. */
async function pendingFor(pool, userId) {
  const { rows } = await pool.query("SELECT * FROM trial_signups WHERE telegram_id = $1 AND used_at IS NULL ORDER BY id DESC LIMIT 1", [userId]);
  return rows[0] || null;
}

/**
 * Bot step 2: the shared contact. { ok, agency, broker } or
 * { error: none|expired|locked|not_own|mismatch|trial_used|phone_taken }. not_own and mismatch use up one of the 5 attempts.
 */
async function verifyContact(pool, contact, ids, { now = new Date() } = {}) {
  const s = await pendingFor(pool, ids.userId);
  if (!s) return { error: "none" };
  if (new Date(s.expires_at) <= now) return { error: "expired" };
  if (s.attempts >= MAX_ATTEMPTS) return { error: "locked" };
  const fail = async (error) => {
    const { rows } = await pool.query("UPDATE trial_signups SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts", [s.id]);
    return { error: rows[0].attempts >= MAX_ATTEMPTS ? "locked" : error };
  };
  if (!contact || contact.user_id === undefined || Number(contact.user_id) !== Number(ids.userId)) return fail("not_own");
  const shared = Phone.normalizePhone(contact.phone_number);
  if (!shared || `+${shared}` !== s.phone_e164) return fail("mismatch");

  const digits = s.phone_e164.slice(1);
  try {
    return await withTransaction(pool, async (client) => {
      const settings = await Signup.trialSettings(client);
      const tier = settings.tiers[s.tier || "solo"];
      if (!settings.enabled || !tier.enabled) return { error: "closed" };
      const trialEnds = new Date(now.getTime() + tier.days * DAY).toISOString();
      if (await claimed(client, { phone: digits, telegramId: ids.userId })) return { error: "trial_used" };
      const { rows: taken } = await client.query("SELECT 1 FROM brokers WHERE phone_normalized = $1 OR telegram_user_id = $2", [digits, ids.userId]);
      if (taken.length) return { error: "phone_taken" };
      const { rows: a } = await client.query(
        `INSERT INTO agencies (name, plan, pilot, approval, trial_ends_at, signed_up_at, referred_by, trial_ai_credits) VALUES ($1, $2, false, 'approved', $3, $4, $5, $6)
         RETURNING id, name, slug, trial_ends_at`,
        [s.agency_name, s.tier === "team" ? "trial_team" : Plans.TRIAL.plan, trialEnds, now.toISOString(), s.referred_by, tier.credits]
      );
      const { rows: b } = await client.query(
        `INSERT INTO brokers (agency_id, phone_number, name, role, preferred_lang, is_active, telegram_user_id, telegram_chat_id, telegram_linked_at)
         VALUES ($1, $2, $3, 'owner', $4, true, $5, $6, NOW())
         RETURNING id, agency_id, name, phone_number, phone_normalized, role, preferred_lang, is_active, telegram_user_id, telegram_chat_id`,
        [a[0].id, digits, s.owner_name, s.lang, ids.userId, ids.chatId]
      );
      await client.query("INSERT INTO trial_claims (phone_e164, telegram_id, agency_id) VALUES ($1, $2, $3)", [s.phone_e164, ids.userId, a[0].id]);
      await client.query("UPDATE trial_signups SET used_at = NOW() WHERE id = $1", [s.id]);
      await client.query(
        "UPDATE trial_funnel SET verified_at = $2, agency_id = $3, granted_days = $4, granted_credits = $5 WHERE signup_id = $1",
        [s.id, now.toISOString(), a[0].id, tier.days, tier.credits]
      );
      return { ok: true, agency: a[0], broker: b[0], trialDays: tier.days };
    });
  } catch (e) {
    if (e && e.code === "23505") return { error: "trial_used" }; // a concurrent claim won the unique index
    throw e;
  }
}

/** Drops finished and long-expired pending signups (privacy job). */
async function purge(pool) {
  const { rowCount } = await pool.query("DELETE FROM trial_signups WHERE used_at IS NOT NULL OR expires_at < NOW() - INTERVAL '1 day'");
  return rowCount || 0;
}

module.exports = { TOKEN_PREFIX, TTL_MS, MAX_ATTEMPTS, LIMITS, isSignupToken, claimed, start, begin, pendingFor, verifyContact, purge };
