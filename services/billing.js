// services/billing.js — Plans, allowances and manual payments (phase 2 step 4).
// The plan in force (effectivePlan): a pilot agency is on Office for free until the POC ends; a paid period runs to
// paid_until; a self sign-up gets the 14-day trial (1 seat, 50 units, 80 AI credits in all). When a paid or trial period ends
// the agency walks down an expiry ladder derived from the dates (no stored state): grace (paid only: everything works, AI on a
// tight quota) → read-only (view, local search, export, pay) → blocked (plan/payment page and export only). The Free plan is
// retired for an agency that ever had a trial or paid period; an agency with neither keeps the old Free behaviour. Nothing is
// ever deleted: past an allowance the AI features stop (lib/ai.js checks before every call) and past the seats no one new can be
// added, while everything already there stays readable.
// Payments are manual (InstaPay or bank transfer): a manager announces one and gets an amount and a reference, the
// owner confirms it on /app/owner and the plan period is extended (a voice pack adds 100 voice notes to that month).
// While a paid period runs only the same plan for the same length (a renewal, queued after the end) or a higher plan (an `upgrade`
// payment, pro-rated to the days left, paid_until unchanged) can be bought; downgrades and length switches wait for the expiry.
// A 12-month payment locks the list prices (agencies.locked_prices until lock_until); a Founding Partner's first one locks 24 months.
// The platform owner can add 1 to 4 extra seats mid-contract (addExtraSeats: 180 EGP a seat a month up front, +400 credits each).
"use strict";

const crypto = require("crypto");
const Plans = require("../domain/plans");
const Credits = require("./credits");
const { withTransaction } = require("../lib/db");
const { MANAGER_ROLES, isAgencyOwner } = require("../lib/authz");
const Referrals = require("./referrals");
const Vis = require("../lib/visibility");

// lib/planGuard.js remembers an agency's plan state for 15 s: every write of plan or payment state drops it (lazy: planGuard needs this module).
const forgetPlanState = (agencyId) => require("../lib/planGuard").forget(agencyId);

const DAY = 24 * 3600 * 1000;
// The periods a plan can be sold for; which of them a given plan offers is its price table (domain/plans.js prices).
const MONTHS = [1, 6, 12];
const MAX_PENDING = 3;
const MONTH_START = "(date_trunc('month', $2::timestamptz AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo')";
const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const isManager = (b) => MANAGER_ROLES.includes(String(b?.role || "").toLowerCase());

// --- the expiry ladder ----------------------------------------------------------------------------------------------
// Days of grace and of read-only after the period end, by the kind of period that ended: a monthly plan, a plan paid for
// 6 or 12 months (the last confirmed plan payment has months >= 6) and the trial (no grace). After read-only: blocked.
const LADDER = Object.freeze({ monthly: { grace: 3, readonly: 7 }, long: { grace: 7, readonly: 14 }, trial: { grace: 0, readonly: 7 } });
// A plan payment announced but not yet confirmed holds the clock for at most this long (a cancelled one releases it at once).
const PENDING_HOLD_MS = 3 * DAY;
const GRACE_EXTEND_DAYS = [3, 7];
const GRACE_AI_PCT_DEFAULT = 15;
/** The phases in which top-ups (and extra seats) need an active plan. */
const LAPSED = ["grace", "readonly", "blocked"];

/**
 * Where an agency is on the ladder once its period ended (null for a pilot and for an agency that never had a trial or paid
 * period; the phase is "trial" while a pending payment holds a trial's clock): { kind, end, graceEnd, readonlyEnd, phase, paused, pauseMs }.
 * end is the period end; graceEnd is when read-only starts (= end for a trial, which has no grace); readonlyEnd is when blocked starts.
 * A pending plan payment holds the clock for the time it has waited (3 days at most); the owner's grace_extra_until can push grace
 * later. Everything is derived from the row, so `now` can be injected.
 */
function ladderOf(agency, now = new Date()) {
  if (!agency || agency.pilot) return null;
  const paidEnd = agency.paid_until ? new Date(agency.paid_until) : null;
  const trialEnd = agency.trial_ends_at ? new Date(agency.trial_ends_at) : null;
  if (!paidEnd && !trialEnd) return null;
  const trial = !paidEnd || Boolean(trialEnd && trialEnd > paidEnd);
  const end = trial ? trialEnd : paidEnd;
  const kind = trial ? "trial" : Number(agency.last_months) >= 6 ? "long" : "monthly";
  const d = LADDER[kind];
  let pause = 0;
  if (agency.pending_plan_at) pause = Math.min(PENDING_HOLD_MS, Math.max(0, now - Math.max(new Date(agency.pending_plan_at), end)));
  const t = now - pause; // the clock the ladder runs on
  let graceEnd = new Date(end.getTime() + d.grace * DAY);
  if (!trial && agency.grace_extra_until && new Date(agency.grace_extra_until) > graceEnd) graceEnd = new Date(agency.grace_extra_until);
  const readonlyEnd = new Date(graceEnd.getTime() + d.readonly * DAY);
  const phase = trial ? (t < end ? "trial" : t < readonlyEnd ? "readonly" : "blocked") : t < graceEnd ? "grace" : t < readonlyEnd ? "readonly" : "blocked";
  return { kind, end, graceEnd, readonlyEnd, phase, paused: pause > 0, pauseMs: pause };
}

/**
 * The plan in force for an agency row: { plan, source: pilot|paid|trial|grace|readonly|blocked|free, until }.
 * until: the end of the running period, or of the grace / read-only phase (null when blocked, pilot, free). The lapsed sources
 * (grace, readonly, blocked) also carry kind (monthly|long|trial), end (the period end), readonlyStarts and blockedStarts.
 */
function effectivePlan(agency, now = new Date()) {
  if (!agency) return { plan: Plans.FREE, source: "free", until: null };
  if (agency.pilot) {
    // A pilot is on Office, or on its own bigger plan when one was set (NCH is on Agency).
    const office = Plans.planById("office");
    const own = Plans.planById(agency.plan);
    return { plan: own && own.seats >= office.seats ? own : office, source: "pilot", until: null };
  }
  if (agency.paid_until && new Date(agency.paid_until) > now) return { plan: Plans.planById(agency.plan) || Plans.FREE, source: "paid", until: new Date(agency.paid_until) };
  if (agency.trial_ends_at && new Date(agency.trial_ends_at) > now) return { plan: Plans.planById(Plans.TRIAL.plan), source: "trial", until: new Date(agency.trial_ends_at) };
  // The Free plan is retired for an agency that ever had a trial or paid period; one with neither keeps it.
  const l = ladderOf(agency, now);
  if (!l) return { plan: Plans.FREE, source: "free", until: null };
  const plan = (l.kind === "trial" ? Plans.planById(Plans.TRIAL.plan) : Plans.planById(agency.plan)) || Plans.FREE;
  const info = { kind: l.kind, end: l.end, readonlyStarts: l.graceEnd, blockedStarts: l.readonlyEnd, paused: l.paused };
  if (l.phase === "trial") return { plan, source: "trial", until: l.end, ...info };
  return { plan, source: l.phase, until: l.phase === "grace" ? l.graceEnd : l.phase === "readonly" ? l.readonlyEnd : null, ...info };
}

/** Where an agency's trial began: its credits are one allowance for the whole trial, not a monthly one. */
const trialStart = (agency) => new Date(agency.signed_up_at || agency.created_at || new Date(agency.trial_ends_at) - Plans.TRIAL.days * DAY);

async function agencyRow(db, agencyId) {
  const { rows } = await db.query(
    `SELECT a.id, a.name, a.plan, a.paid_until, a.trial_ends_at, a.pilot, a.approval, a.grace_extra_until, a.signed_up_at, a.created_at,
            a.extra_seats, a.locked_prices, a.lock_until, a.founding_partner,
            (SELECT p.months FROM payments p WHERE p.agency_id = a.id AND p.kind = 'plan' AND p.status = 'confirmed'
              ORDER BY p.confirmed_at DESC NULLS LAST LIMIT 1) AS last_months,
            (SELECT min(p.created_at) FROM payments p WHERE p.agency_id = a.id AND p.kind = 'plan' AND p.status = 'pending') AS pending_plan_at
       FROM agencies a WHERE a.id = $1`,
    [agencyId]
  );
  return rows[0] || null;
}

/** The share (%) of one month's pool a 6 or 12 month plan gets in grace; the owner sets it on the Plans page (app_settings grace_ai_pct). */
async function graceAiPct(db) {
  const n = Number(await getSetting(db, "grace_ai_pct", GRACE_AI_PCT_DEFAULT));
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : GRACE_AI_PCT_DEFAULT;
}

/**
 * The credits an agency has and what it used: { used, total, plan, bundles, grants }.
 * - Paid, pilot, free: the month's pool (plan + bundles + grants) against this Cairo month's use.
 * - Trial: the plan's credits are ONE allowance for the whole trial: use is counted since the trial began, not per month.
 * - Grace: no monthly refill. The pool is what was left of the last paid month (its pool minus its use up to paid_until); a
 *   6 or 12 month plan gets the greater of that and grace_ai_pct % of one month's plan credits, never both. Use is counted
 *   since paid_until. Bundles and grants of the new month are not added.
 * - Read-only and blocked: 0 (AI is refused before this: checkAllowance).
 */
async function creditState(db, agency, eff, { now = new Date() } = {}) {
  const { plan, source } = eff;
  if (source === "grace") {
    const last = new Date(eff.end.getTime() - 1);
    const [pool, usedLast] = await Promise.all([Credits.poolFor(db, agency.id, plan.id, { now: last }), Credits.usedThisMonth(db, agency.id, { now: last, until: eff.end })]);
    const leftover = Math.max(0, pool.total - usedLast);
    const share = eff.kind === "long" ? Math.round(((plan.credits + Plans.EXTRA_SEAT.credits * Number(agency.extra_seats || 0)) * (await graceAiPct(db))) / 100) : 0;
    const total = Math.max(leftover, share);
    const used = await Credits.usedThisMonth(db, agency.id, { now, since: eff.end });
    return { used, total, plan: total, bundles: 0, grants: 0 };
  }
  if (source === "readonly" || source === "blocked") return { used: 0, total: 0, plan: 0, bundles: 0, grants: 0 };
  const [used, pool] = await Promise.all([
    source === "trial" ? Credits.usedThisMonth(db, agency.id, { now, since: trialStart(agency) }) : Credits.usedThisMonth(db, agency.id, { now }),
    Credits.poolFor(db, agency.id, plan.id, { now })
  ]);
  return { used, total: pool.total, plan: pool.plan, bundles: pool.bundles, grants: pool.grants };
}

/** The agency's seats and units now (available, archived and sold; deleted ones don't count). */
async function monthUsage(db, agencyId) {
  const { rows } = await db.query(
    `SELECT
       (SELECT count(*)::int FROM brokers WHERE agency_id = $1 AND is_active) AS seats,
       (SELECT count(*)::int FROM listings WHERE ${Vis.allUnits()} AND agency_id = $1 AND status IN ('active', 'archived', 'sold')) AS units`,
    [agencyId]
  );
  return rows[0];
}

/**
 * The agency's plan and how much of it is used this month.
 * @returns {Promise<{ plan, source, until, credits: { used, limit, plan, bundles, grants }, seats: { used, limit }, units }>}
 */
async function allowance(db, agencyId, { now = new Date() } = {}) {
  const agency = await agencyRow(db, agencyId);
  const eff = effectivePlan(agency, now);
  const { plan, source, until } = eff;
  const [u, cs] = await Promise.all([monthUsage(db, agencyId), creditState(db, agency, eff, { now })]);
  return {
    agency,
    plan,
    source,
    until,
    ladder: LAPSED.includes(source) ? { kind: eff.kind, end: eff.end, readonlyStarts: eff.readonlyStarts, blockedStarts: eff.blockedStarts, paused: eff.paused } : null,
    credits: { used: cs.used, limit: cs.total, plan: cs.plan, bundles: cs.bundles, grants: cs.grants },
    // The seat limit is the plan's seats plus the extra seats the platform owner added (0 to 4; they stay until a new paid period starts after expiry).
    seats: { used: u.seats, limit: plan.seats + Number(agency?.extra_seats || 0) },
    extraSeats: Number(agency?.extra_seats || 0),
    units: { used: u.units, limit: await unitLimit(db, plan) }
  };
}

/**
 * What an agency-facing API may show of allowance(): a whitelist. The agency row (founding_partner, locked_prices, lock_until,
 * extra_seats, grace_extra_until ...) and extraSeats stay on the server: extra seats show only through seats.limit and credits.
 */
function publicAllowance(a) {
  if (!a) return null;
  const p = a.plan || {};
  const meter = (m) => ({ used: m.used, limit: m.limit });
  return {
    plan: { id: p.id, name: p.name, priceEgp: p.priceEgp, seats: p.seats, units: p.units, credits: p.credits, prices: p.prices },
    source: a.source,
    until: a.until,
    ladder: a.ladder,
    credits: { used: a.credits.used, limit: a.credits.limit, plan: a.credits.plan, bundles: a.credits.bundles, grants: a.credits.grants },
    seats: meter(a.seats),
    units: meter(a.units)
  };
}

/** A payment row as an agency-facing API shows it: the audit `detail` (price lock basis) and `seats` stay server-side. */
function publicPayment(p) {
  const { detail, seats, ...rest } = p || {};
  return rest;
}

/** The unit cap per plan ({ free, solo, office, agency, ... } → number): set on the owner's Plans and credits section. */
async function planLimits() {
  const out = {};
  for (const p of Plans.ALL) out[p.id] = p.units;
  return out;
}

async function unitLimit(db, plan) {
  return plan.units;
}

/**
 * Whether one more unit fits the plan: { ok, used, limit, plan }. Available, archived and sold units all count (they all
 * stay in the agency's inventory and take storage); only deleted units don't.
 */
async function unitCapacity(db, agencyId, { adding = 1, now = new Date() } = {}) {
  const agency = await agencyRow(db, agencyId);
  const { plan } = effectivePlan(agency, now);
  const { rows } = await db.query("SELECT count(*)::int AS n FROM listings WHERE " + Vis.allUnits() + " AND agency_id = $1 AND status IN ('active', 'archived', 'sold')", [agencyId]);
  const limit = await unitLimit(db, plan);
  return { ok: rows[0].n + adding <= limit, used: rows[0].n, limit, plan };
}

// The unit cap warns at these percentages (soft warning at 85, then the cap itself at 100); never for an unlimited plan.
const UNIT_HINT_LEVELS = [85, 100];

/** The highest unit warning level reached by { used, limit } (85 or 100), or null (also for a plan with no unit cap). */
function unitLevel({ used, limit }) {
  if (!(limit > 0) || limit >= Plans.UNLIMITED) return null;
  const pct = (used * 100) / limit;
  let out = null;
  for (const l of UNIT_HINT_LEVELS) if (pct >= l) out = l;
  return out;
}

/** The agency's unit use for the banners: { used, limit, plan, level } (level: see unitLevel). */
async function unitStatus(db, agencyId, { now = new Date() } = {}) {
  const c = await unitCapacity(db, agencyId, { adding: 0, now });
  return { used: c.used, limit: c.limit, plan: c.plan, level: unitLevel(c) };
}

/**
 * Throws PLAN_QUOTA_EXCEEDED (handled like the daily AI caps) when the agency has used this month's credits (the plan's
 * pool plus bundles and grants; services/credits.js), or, in the agency's per-person mode, when this person (brokerId)
 * has used their own allowance (err.kind "user"; services/aiUserLimits.js). Both must pass: the pool still caps the agency. Only AI calls are checked, so searches fall back to the local
 * parser and the website forms keep working with no AI when the credits are gone.
 */
async function checkAllowance(db, agencyId, { now = new Date(), brokerId = null } = {}) {
  const agency = await agencyRow(db, agencyId);
  const eff = effectivePlan(agency, now);
  // Read-only and blocked: no AI at all. Callers fall back to the local parser / forms and say how to pay (lib/aiBlock.js kind "plan").
  if (eff.source === "readonly" || eff.source === "blocked") {
    const err = new Error(`AI is off: the plan period ended (${eff.source})`);
    err.code = "PLAN_EXPIRED";
    err.phase = eff.source;
    throw err;
  }
  const pool = await creditState(db, agency, eff, { now });
  const used = pool.used;
  warnLevel(db, agencyId, used, pool.total, now);
  if (used >= pool.total) {
    const err = new Error(eff.source === "grace" ? "AI credits used up for the grace period" : eff.source === "trial" ? "AI credits of the trial used up" : "AI credits used up for the month");
    err.code = "PLAN_QUOTA_EXCEEDED";
    err.kind = "credits";
    if (eff.source === "grace") err.grace = true;
    if (eff.source === "trial") err.trial = true;
    err.limit = pool.total;
    err.used = used;
    throw err;
  }
  if (brokerId) {
    const own = await require("./aiUserLimits").overOwnLimit(db, agencyId, brokerId, { now });
    if (own.blocked) {
      const err = new Error("AI credits used up for this person this month");
      err.code = "PLAN_QUOTA_EXCEEDED";
      err.kind = "user";
      err.limit = own.allowance;
      err.used = own.used;
      throw err;
    }
  }
  return { used, limit: pool.total };
}

// Levels already told this process run (agency:month:level); the notification itself is deduped per month as well.
const warned = new Set();
/** At 80% and 100% of the month's AI credits the managers hear once (lib/notifications.js aiCreditWarning). Never blocks. */
function warnLevel(db, agencyId, used, limit, now) {
  if (!limit || limit <= 0) return;
  const level = used >= limit ? 100 : used / limit >= 0.8 ? 80 : 0;
  if (!level) return;
  const key = `${agencyId}:${Credits.monthKey(now)}:${level}`;
  if (warned.has(key)) return;
  warned.add(key);
  Promise.resolve()
    .then(() => require("../lib/notifications").aiCreditWarning(db, agencyId, { level, used, limit, now }))
    .catch(() => warned.delete(key));
}

/** Whether one more active broker fits the plan. */
async function seatAvailable(db, agencyId, { now = new Date() } = {}) {
  const a = await allowance(db, agencyId, { now });
  return a.seats.used < a.seats.limit;
}

// --- owner settings -------------------------------------------------------------------------------------------------

async function getSetting(db, key, fallback) {
  const { rows } = await db.query("SELECT value FROM app_settings WHERE key = $1", [key]);
  return rows[0] ? rows[0].value : fallback;
}

async function setSetting(db, key, value) {
  await db.query(
    "INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
    [key, JSON.stringify(value)]
  );
}

/** Where agencies pay: { instapay, bank } as the owner typed them (shown to managers with the amount and reference). */
async function payTo(db) {
  const v = await getSetting(db, "pay_to", {});
  return { instapay: String(v.instapay || ""), bank: String(v.bank || "") };
}

async function savePayTo(db, { instapay, bank }) {
  await setSetting(db, "pay_to", { instapay: String(instapay || "").trim().slice(0, 120), bank: String(bank || "").trim().slice(0, 300) });
}

// --- payments -------------------------------------------------------------------------------------------------------

function newReference() {
  const bytes = crypto.randomBytes(6);
  return `WH-${[...bytes].map((b) => REF_ALPHABET[b % REF_ALPHABET.length]).join("")}`;
}

/** The amount for a plan and months from the plan's price table, or an extra credit bundle; null for a period the plan doesn't offer. */
function priceOf({ kind, plan, months, bundle }) {
  if (kind === "credit_bundle") return Plans.bundleById(bundle)?.priceEgp ?? null;
  const p = Plans.PLANS.find((x) => x.id === plan);
  return p && MONTHS.includes(months) ? Plans.priceFor(p, months) : null;
}

/** Whether the agency's price lock is in force: { plan: { months: EGP } } with lock_until in the future. */
const lockOf = (agency, now) => (agency?.locked_prices && agency.lock_until && new Date(agency.lock_until) > now ? agency.locked_prices : null);

/**
 * The price an agency pays for a plan and period: the list price, or its locked price (agencies.locked_prices while lock_until
 * is in the future) when that is lower. { amount, locked } or null for a period the plan doesn't offer.
 */
function priceAt(agency, planId, months, now = new Date()) {
  const list = priceOf({ kind: "plan", plan: planId, months: Number(months) });
  if (!list) return null;
  const lock = Number(lockOf(agency, now)?.[planId]?.[months]);
  return Number.isFinite(lock) && lock > 0 && lock < list ? { amount: lock, locked: true } : { amount: list, locked: false };
}

/** Price lock snapshot written when a 12-month payment is confirmed: { plan: { months: EGP } } of every plan sold now. */
const priceSnapshot = () => Object.fromEntries(Plans.PLANS.map((p) => [p.id, Object.fromEntries(Plans.periodsOf(p).map((m) => [m, Plans.priceFor(p, m)]))]));

/**
 * What the rules allow while a paid period still runs (paid_until in the future): only the same plan renewed for the same length
 * (queued after the end) or a higher tier through an upgrade. Returns an error code or null. Never applies in grace, read-only,
 * blocked (any plan and period may be chosen then), on a trial, or on a pilot.
 *   downgrade: a lower plan.  upgrade_required: a higher plan bought as a plain plan payment (use the pro-rated upgrade).
 *   period_switch: the same plan for another length (6 to 12 months and so on).
 */
function planChangeError(agency, eff, planId, months) {
  if (eff.source !== "paid") return null;
  const cur = Plans.tierOf(agency.plan);
  const next = Plans.tierOf(planId);
  if (cur < 0 || next < 0) return null;
  if (next < cur) return "downgrade";
  if (next > cur) return "upgrade_required";
  const last = Number(agency.last_months);
  if (last && Number(months) !== last) return "period_switch";
  return null;
}

/**
 * The pro-rated price of moving a paid agency to a higher plan for the rest of its period:
 * (new plan per month - current plan per month) x remaining days / 30, rounded to whole EGP. Per month = the explicit price of
 * the period divided by its months: the current plan at the length of the current period (the last confirmed plan payment; the
 * monthly price when unknown), the new plan at the same length (its shortest period when it is not sold for that length, e.g.
 * Agency is never monthly). A price lock counts as the price paid. paid_until does not move.
 * @returns {{ ok, amount, detail } | { error }} error: lapsed | not_paid | plan | same_plan | downgrade | amount
 */
function quoteUpgrade(agency, planId, now = new Date()) {
  const eff = effectivePlan(agency, now);
  if (LAPSED.includes(eff.source)) return { error: "lapsed" };
  if (eff.source !== "paid") return { error: "not_paid" };
  const target = Plans.PLANS.find((x) => x.id === planId);
  const cur = Plans.planById(agency.plan);
  if (!target || !cur || Plans.tierOf(cur.id) < 0) return { error: "plan" };
  const dt = Plans.tierOf(target.id) - Plans.tierOf(cur.id);
  if (dt === 0) return { error: "same_plan" };
  if (dt < 0) return { error: "downgrade" };
  const last = Number(agency.last_months);
  const curMonths = last && Plans.priceFor(cur, last) ? last : 1;
  const curPaid = priceAt(agency, cur.id, curMonths, now) || { amount: cur.priceEgp, locked: false };
  const toMonths = Plans.priceFor(target, curMonths) ? curMonths : Plans.periodsOf(target)[0];
  const toPrice = priceAt(agency, target.id, toMonths, now);
  if (!toPrice) return { error: "plan" };
  const fromPerMonth = curPaid.amount / curMonths;
  const toPerMonth = toPrice.amount / toMonths;
  const remainingDays = Math.max(0, Math.ceil((new Date(agency.paid_until) - now) / DAY));
  const amount = Math.round(((toPerMonth - fromPerMonth) * remainingDays) / 30);
  if (!(amount > 0)) return { error: "amount" };
  return {
    ok: true,
    amount,
    detail: { from: cur.id, to: target.id, fromMonths: curMonths, toMonths, fromPerMonth: Math.round(fromPerMonth * 100) / 100, toPerMonth: Math.round(toPerMonth * 100) / 100, remainingDays, locked: Boolean(curPaid.locked || toPrice.locked) }
  };
}

/** The upgrades open to an agency now, for the Plan page: { planId: quote } for every higher plan (empty when not on a paid period). */
function upgradeQuotes(agency, now = new Date()) {
  const out = {};
  for (const p of Plans.PLANS) {
    const q = quoteUpgrade(agency, p.id, now);
    if (q.ok) out[p.id] = q;
  }
  return out;
}

/**
 * A manager announces a payment: { ok, payment } with its amount and reference, or { error }.
 * @param {Object} input - { kind: plan|upgrade|credit_bundle, plan, months, bundle }
 * Error codes beyond plan / forbidden / too_many / lapsed: downgrade, upgrade_required, period_switch, same_plan, not_paid,
 * upgrade_pending, amount (see planChangeError and quoteUpgrade).
 */
async function requestPayment(db, manager, input = {}, { now = new Date() } = {}) {
  if (!isAgencyOwner(manager)) return { error: "forbidden" };
  const kind = input.kind === "credit_bundle" ? "credit_bundle" : input.kind === "upgrade" ? "upgrade" : "plan";
  const months = kind === "plan" ? Number(input.months) : 1;
  const plan = kind === "plan" || kind === "upgrade" ? String(input.plan || "") : null;
  const bundle = kind === "credit_bundle" ? String(input.bundle || "") : null;
  if (kind !== "upgrade" && !priceOf({ kind, plan, months, bundle })) return { error: "plan" };
  const agency = await agencyRow(db, manager.agency_id);
  if (!agency || agency.approval !== "approved") return { error: "forbidden" };
  const eff = effectivePlan(agency, now);
  // Top-ups (and extra seats) need an active plan: not in grace, read-only or blocked. A plan payment is always allowed.
  if (kind === "credit_bundle" && LAPSED.includes(eff.source)) return { error: "lapsed" };
  let amount;
  let rowMonths = months;
  let detail = null;
  if (kind === "upgrade") {
    const q = quoteUpgrade(agency, plan, now);
    if (q.error) return { error: q.error };
    const { rows: dup } = await db.query("SELECT 1 FROM payments WHERE agency_id = $1 AND kind = 'upgrade' AND status = 'pending' LIMIT 1", [manager.agency_id]);
    if (dup.length) return { error: "upgrade_pending" };
    amount = q.amount;
    rowMonths = q.detail.fromMonths;
    detail = q.detail;
  } else if (kind === "plan") {
    const why = planChangeError(agency, eff, plan, months);
    if (why) return { error: why };
    const p = priceAt(agency, plan, months, now);
    amount = p.amount;
    if (p.locked) detail = { locked: true, list: priceOf({ kind, plan, months }) };
  } else {
    amount = priceOf({ kind, plan, months, bundle });
  }
  const { rows: open } = await db.query("SELECT count(*)::int AS n FROM payments WHERE agency_id = $1 AND status = 'pending'", [manager.agency_id]);
  if (open[0].n >= MAX_PENDING) return { error: "too_many" };
  for (let i = 0; i < 5; i++) {
    const { rows } = await db.query(
      `INSERT INTO payments (agency_id, kind, plan, months, amount_egp, reference, requested_by, bundle_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) ON CONFLICT (reference) DO NOTHING RETURNING *`,
      [manager.agency_id, kind, plan, rowMonths, amount, newReference(), manager.id, bundle, detail ? JSON.stringify(detail) : null]
    );
    if (rows[0]) {
      forgetPlanState(manager.agency_id);
      return { ok: true, payment: rows[0], agency };
    }
  }
  throw new Error("Could not allocate a payment reference");
}

/**
 * Hidden admin override (the platform owner only, not on the website): adds 1 to 4 extra seats mid-contract at 180 EGP a seat a
 * month, billed up front for the months left (ceil(days left / 30)); each seat adds 400 credits a month to the pool. Writes an
 * already confirmed 'extra_seats' payment with a reference (the audit trail). Not in grace, read-only or blocked, not on a pilot,
 * not beyond 4 extra seats in all. { ok, payment, extraSeats } or { error }: forbidden | invalid | not_found | pilot | lapsed | not_paid | limit.
 */
async function addExtraSeats(pool, owner, agencyId, seats, { now = new Date() } = {}) {
  if (!require("./dashboards").isOwner(owner)) return { error: "forbidden" };
  const n = Number(seats);
  if (!Number.isInteger(n) || n < 1 || n > Plans.EXTRA_SEAT.max) return { error: "invalid" };
  return withTransaction(pool, async (client) => {
    await client.query("SELECT 1 FROM agencies WHERE id = $1 FOR UPDATE", [agencyId]);
    const agency = await agencyRow(client, agencyId);
    if (!agency) return { error: "not_found" };
    if (agency.pilot) return { error: "pilot" };
    const eff = effectivePlan(agency, now);
    if (LAPSED.includes(eff.source)) return { error: "lapsed" };
    if (eff.source !== "paid") return { error: "not_paid" };
    if (Number(agency.extra_seats || 0) + n > Plans.EXTRA_SEAT.max) return { error: "limit" };
    const monthsLeft = Math.min(60, Math.max(1, Math.ceil((new Date(agency.paid_until) - now) / DAY / 30)));
    const amount = Plans.EXTRA_SEAT.priceEgp * n * monthsLeft;
    const detail = JSON.stringify({ seats: n, perSeat: Plans.EXTRA_SEAT.priceEgp, monthsLeft, credits: Plans.EXTRA_SEAT.credits * n, before: Number(agency.extra_seats || 0), paid_until: agency.paid_until });
    let payment = null;
    for (let i = 0; i < 5 && !payment; i++) {
      const { rows } = await client.query(
        `INSERT INTO payments (agency_id, kind, months, amount_egp, reference, status, requested_by, confirmed_at, seats, detail)
         VALUES ($1, 'extra_seats', $2, $3, $4, 'confirmed', $5, $6, $7, $8::jsonb) ON CONFLICT (reference) DO NOTHING RETURNING *`,
        [agencyId, monthsLeft, amount, newReference(), owner.id, now.toISOString(), n, detail]
      );
      payment = rows[0] || null;
    }
    if (!payment) throw new Error("Could not allocate a payment reference");
    const { rows: a } = await client.query("UPDATE agencies SET extra_seats = extra_seats + $2, updated_at = NOW() WHERE id = $1 RETURNING extra_seats", [agencyId, n]);
    return { ok: true, payment, extraSeats: a[0].extra_seats };
  });
}

async function paymentsOf(db, agencyId, { limit = 20 } = {}) {
  const { rows } = await db.query("SELECT * FROM payments WHERE agency_id = $1 ORDER BY created_at DESC LIMIT $2", [agencyId, limit]);
  return rows;
}

async function pendingPayments(db) {
  const { rows } = await db.query(
    `SELECT p.*, a.name AS agency_name FROM payments p JOIN agencies a ON a.id = p.agency_id
      WHERE p.status = 'pending' ORDER BY p.created_at`
  );
  return rows;
}

/**
 * The owner confirms a payment: a plan payment extends paid_until by its months from the later of now and the current
 * end (and the agency is no longer a free pilot), plus any referral months it earns (services/referrals.js); a credit
 * bundle adds its credits for the month it is confirmed in; an upgrade changes the plan only (paid_until stays).
 * Also on a plan payment: a 12-month payment writes the price lock (locked_prices / lock_until), a payment that used the lock
 * consumes it, and extra_seats goes back to 0 when the period had ended (a new paid period after expiry, not a renewal).
 * Errors: not_found, not_pending, upgrade_stale (the agency is no longer on a paid period or already on that tier),
 * not_allowed (the payment would now be a downgrade or period switch; cancel it).
 * @returns {Promise<{ ok, payment, agency, referral } | { error }>}
 */
async function confirmPayment(pool, id, { now = new Date() } = {}) {
  const out = await withTransaction(pool, async (client) => {
    const { rows } = await client.query("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [id]);
    const p = rows[0];
    if (!p) return { error: "not_found" };
    if (p.status !== "pending") return { error: "not_pending", payment: p };
    // Where the agency stood before this payment (the row is read while the payment is still pending, as the agency saw it).
    await client.query("SELECT 1 FROM agencies WHERE id = $1 FOR UPDATE", [p.agency_id]);
    const isPlan = p.kind === "plan";
    const before = isPlan || p.kind === "upgrade" ? await agencyRow(client, p.agency_id) : null;
    const was = before ? effectivePlan(before, now) : null;
    if (p.kind === "upgrade" && (was.source !== "paid" || !(Plans.tierOf(p.plan) > Plans.tierOf(before.plan)))) return { error: "upgrade_stale", payment: p };
    if (isPlan && planChangeError(before, was, p.plan, p.months)) return { error: "not_allowed", payment: p };
    const { rows: done } = await client.query("UPDATE payments SET status = 'confirmed', confirmed_at = $2 WHERE id = $1 RETURNING *", [id, now.toISOString()]);
    let agency;
    let referral = null;
    let restored = null;
    if (isPlan) {
      referral = await Referrals.onPlanPayment(client, p.agency_id, { now });
      // The new period starts at the old paid_until when paid inside grace (grace days are not free days), and from the later of
      // now and the current end otherwise (a payment while the plan still runs is queued after it; after read-only it starts today).
      const oldEnd = before.paid_until ? new Date(before.paid_until) : null;
      const start = was.source === "grace" && oldEnd ? oldEnd : new Date(Math.max(oldEnd ? oldEnd.getTime() : 0, now.getTime()));
      // The price lock: a payment that was priced from the lock uses it up; a fresh 12-month payment locks today's prices for 12
      // months (24 for a Founding Partner's first 12-month payment: its first renewal cycle is covered too).
      let lock = { sql: "", args: [] };
      if (p.detail?.locked) {
        lock = { sql: ", locked_prices = NULL, lock_until = NULL", args: [] };
      } else if (p.months === 12) {
        const { rows: prior } = await client.query("SELECT count(*)::int AS n FROM payments WHERE agency_id = $1 AND kind = 'plan' AND status = 'confirmed' AND months = 12 AND id <> $2", [p.agency_id, p.id]);
        const lockMonths = before.founding_partner && prior[0].n === 0 ? 24 : 12;
        lock = { sql: ", locked_prices = $6::jsonb, lock_until = $3::timestamptz + make_interval(months => $7)", args: [JSON.stringify(priceSnapshot()), lockMonths] };
      }
      const { rows: a } = await client.query(
        `UPDATE agencies SET plan = $2, pilot = false, grace_extra_until = NULL,
                paid_until = $3::timestamptz + make_interval(months => $4),
                extra_seats = CASE WHEN $5::boolean THEN 0 ELSE extra_seats END${lock.sql},
                updated_at = NOW()
          WHERE id = $1 RETURNING id, name, plan, paid_until, trial_ends_at, pilot, approval, extra_seats`,
        [p.agency_id, p.plan, start.toISOString(), p.months + referral.bonus, was.source !== "paid", ...lock.args]
      );
      agency = a[0];
      if (LAPSED.includes(was.source)) restored = { from: was.source };
    } else if (p.kind === "upgrade") {
      const { rows: a } = await client.query(
        "UPDATE agencies SET plan = $2, updated_at = NOW() WHERE id = $1 RETURNING id, name, plan, paid_until, trial_ends_at, pilot, approval, extra_seats",
        [p.agency_id, p.plan]
      );
      agency = a[0];
    } else {
      agency = await agencyRow(client, p.agency_id);
    }
    return { ok: true, payment: done[0], agency, referral, restored };
  });
  if (out.ok) {
    forgetPlanState(out.payment.agency_id);
    if (out.referral?.referrer) forgetPlanState(out.referral.referrer.id);
  }
  return out;
}

async function cancelPayment(db, id) {
  const { rows } = await db.query("UPDATE payments SET status = 'cancelled' WHERE id = $1 AND status = 'pending' RETURNING *", [id]);
  if (rows[0]) forgetPlanState(rows[0].agency_id);
  return rows[0] ? { ok: true, payment: rows[0] } : { error: "not_pending" };
}

// Days before the end of the period when managers and the owner are reminded: the trial (day 11 and day 13 of 14),
// a monthly plan, and a plan paid for 6 or 12 months (last confirmed plan payment of 6+ months).
const REMINDER_DAYS = { trial: [3, 1], monthly: [7, 3, 1], long: [30, 14, 7, 3, 1] };

/**
 * The reminder due for a period that ends in `remainingMs`: the tightest day count (3, 7, 30, ...) still ahead, so a job
 * that runs late sends one notice, not all of them. { days } or null when none is due yet (or the period already ended).
 */
function reminderDue(kind, remainingMs) {
  if (!(remainingMs > 0)) return null;
  const left = remainingMs / DAY;
  const days = [...REMINDER_DAYS[kind]].sort((a, b) => a - b).find((d) => left <= d);
  return days ? { days } : null;
}

/** Agencies whose trial or paid period ends within `days` (for the reminder job), with last_months: months of the last confirmed plan payment. */
async function endingSoon(db, { now = new Date(), days = 30 } = {}) {
  const until = new Date(now.getTime() + days * DAY).toISOString();
  const { rows } = await db.query(
    `SELECT a.id, a.name, a.plan, a.paid_until, a.trial_ends_at, a.pilot, a.approval,
            (SELECT p.months FROM payments p WHERE p.agency_id = a.id AND p.kind = 'plan' AND p.status = 'confirmed'
              ORDER BY p.confirmed_at DESC NULLS LAST LIMIT 1) AS last_months
       FROM agencies a
      WHERE NOT a.pilot AND a.approval = 'approved'
        AND ((a.paid_until > $1 AND a.paid_until <= $2) OR ((a.paid_until IS NULL OR a.paid_until <= $1) AND a.trial_ends_at > $1 AND a.trial_ends_at <= $2))`,
    [now.toISOString(), until]
  );
  return rows;
}

/** Agencies on a trial, or whose trial ended in the last 30 days without paying (for the owner's "extend" buttons). */
async function trialAgencies(db, { now = new Date() } = {}) {
  const { rows } = await db.query(
    `SELECT id, name, trial_ends_at FROM agencies
      WHERE NOT pilot AND approval = 'approved' AND trial_ends_at IS NOT NULL AND trial_ends_at > $1::timestamptz - interval '30 days'
        AND (paid_until IS NULL OR paid_until <= $1)
      ORDER BY trial_ends_at`,
    [now.toISOString()]
  );
  return rows;
}

const EXTEND_DAYS = [7, 14];

/** The owner extends an agency's trial by 7 or 14 days from the later of now and its current end. */
async function extendTrial(db, agencyId, days, { now = new Date() } = {}) {
  if (!EXTEND_DAYS.includes(Number(days))) return { error: "days" };
  const { rows } = await db.query(
    `UPDATE agencies SET trial_ends_at = GREATEST(COALESCE(trial_ends_at, $2::timestamptz), $2::timestamptz) + make_interval(days => $3), updated_at = NOW()
      WHERE id = $1 AND NOT pilot AND approval = 'approved' RETURNING id, name, trial_ends_at`,
    [agencyId, now.toISOString(), Number(days)]
  );
  if (rows[0]) forgetPlanState(agencyId);
  return rows[0] ? { ok: true, agency: rows[0] } : { error: "not_found" };
}

/**
 * The owner extends an agency's grace by 3 or 7 days from the later of now and its current grace end (a paid agency whose
 * period ended and that is still within its read-only or blocked phase goes back to full access for those days).
 * Stored as grace_extra_until; cleared when the agency pays.
 */
async function extendGrace(db, agencyId, days, { now = new Date() } = {}) {
  if (!GRACE_EXTEND_DAYS.includes(Number(days))) return { error: "days" };
  const agency = await agencyRow(db, agencyId);
  if (!agency || agency.pilot || agency.approval !== "approved") return { error: "not_found" };
  const l = ladderOf(agency, now);
  // Only a paid period can have grace (a trial has none: extend the trial instead).
  if (!l || l.kind === "trial") return { error: "not_lapsed" };
  const from = new Date(Math.max(now.getTime(), l.graceEnd.getTime()));
  const until = new Date(from.getTime() + Number(days) * DAY);
  await db.query("UPDATE agencies SET grace_extra_until = $2, updated_at = NOW() WHERE id = $1", [agencyId, until.toISOString()]);
  forgetPlanState(agencyId);
  return { ok: true, agency: { id: agency.id, name: agency.name, grace_extra_until: until } };
}

/** Paid agencies whose period ended and that are still on the ladder (for the owner's "extend grace" buttons). */
async function lapsedAgencies(db, { now = new Date() } = {}) {
  const { rows } = await db.query(
    `SELECT id FROM agencies WHERE NOT pilot AND approval = 'approved' AND paid_until IS NOT NULL AND paid_until <= $1 AND paid_until > $1::timestamptz - interval '60 days'`,
    [now.toISOString()]
  );
  const out = [];
  for (const r of rows) {
    const a = await agencyRow(db, r.id);
    const l = ladderOf(a, now);
    if (l && l.kind !== "trial") out.push({ id: a.id, name: a.name, phase: l.phase, end: l.end, graceEnd: l.graceEnd, readonlyEnd: l.readonlyEnd });
  }
  return out;
}

// What the owner, managers (and some brokers) are told along the ladder, as offsets from the phase boundaries. Each notice has an id
// (the dedupe key part). Monthly and 6/12 month plans: grace starts at the period end (T0), the day before read-only, read-only starts,
// 3 days before blocked, the last day, blocked. A trial has no grace: the day after it ended (read-only notice), 3 days before blocked,
// the last day, blocked. Brokers hear only when read-only starts, when blocked starts and when access is restored.
function ladderNotices(l) {
  const at = (d, ms = 0) => new Date(d.getTime() + ms);
  if (l.kind === "trial") {
    return [
      { id: "ro_notice", at: at(l.end, DAY), brokers: false },
      { id: "block_3", at: at(l.readonlyEnd, -3 * DAY), brokers: false },
      { id: "block_1", at: at(l.readonlyEnd, -DAY), brokers: false },
      { id: "blocked", at: l.readonlyEnd, brokers: true }
    ];
  }
  return [
    { id: "grace", at: l.end, brokers: false },
    { id: "ro_eve", at: at(l.graceEnd, -DAY), brokers: false },
    { id: "ro_start", at: l.graceEnd, brokers: true },
    { id: "block_3", at: at(l.readonlyEnd, -3 * DAY), brokers: false },
    { id: "block_1", at: at(l.readonlyEnd, -DAY), brokers: false },
    { id: "blocked", at: l.readonlyEnd, brokers: true }
  ];
}

/**
 * The one notice due now for an agency that is past its period end: the tightest (latest) notice whose time has come, so a job that
 * ran late sends one notice and not the whole backlog. { notice, ladder } or null (nothing due, or the agency is not on the ladder).
 */
function ladderNoticeDue(agency, now = new Date()) {
  const l = ladderOf(agency, now);
  if (!l) return null;
  const t = new Date(now - l.pauseMs); // the ladder's own clock (held while a plan payment is pending)
  const due = ladderNotices(l).filter((n) => n.at <= t);
  const notice = due[due.length - 1];
  return notice ? { notice, ladder: l } : null;
}

/** Agencies past their period end (up to 60 days) with what the ladder needs, for the notice job. */
async function lapsedForNotices(db, { now = new Date() } = {}) {
  const { rows } = await db.query(
    `SELECT a.id FROM agencies a
      WHERE NOT a.pilot AND a.approval = 'approved'
        AND ((a.paid_until IS NOT NULL AND a.paid_until <= $1 AND a.paid_until > $1::timestamptz - interval '60 days')
          OR (a.trial_ends_at IS NOT NULL AND a.trial_ends_at <= $1 AND a.trial_ends_at > $1::timestamptz - interval '60 days'))`,
    [now.toISOString()]
  );
  const out = [];
  for (const r of rows) out.push(await agencyRow(db, r.id));
  return out;
}

module.exports = {
  GRACE_EXTEND_DAYS,
  LADDER,
  LAPSED,
  PENDING_HOLD_MS,
  ladderOf,
  ladderNotices,
  ladderNoticeDue,
  lapsedForNotices,
  lapsedAgencies,
  extendGrace,
  graceAiPct,
  creditState,
  agencyRow,
  EXTEND_DAYS,
  trialAgencies,
  extendTrial,
  MONTHS,
  MAX_PENDING,
  effectivePlan,
  allowance,
  checkAllowance,
  seatAvailable,
  planLimits,
  unitCapacity,
  unitStatus,
  unitLevel,
  UNIT_HINT_LEVELS,
  getSetting,
  setSetting,
  payTo,
  savePayTo,
  priceOf,
  priceAt,
  planChangeError,
  quoteUpgrade,
  upgradeQuotes,
  addExtraSeats,
  requestPayment,
  paymentsOf,
  publicAllowance,
  publicPayment,
  pendingPayments,
  confirmPayment,
  cancelPayment,
  endingSoon,
  reminderDue,
  REMINDER_DAYS
};
