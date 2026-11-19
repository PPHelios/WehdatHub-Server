// domain/plans.js — The plans: price in EGP per period, seats, unit cap and the AI credit pool per agency per month.
// The database is the source of truth (credit_plans incl. the per-period `prices`, credit_bundles: services/credits.js, edited on the owner page).
// These objects are filled from it (hydrate) at start and refreshed after each owner edit; the values below are only
// the starting copy of migrations 053, 126 and 128 so code that runs before the first load never meets an empty plan.
// A plan's pool is shared by the whole team; every AI action uses credits (credit_actions).
// The daily AI caps stay on top as a safety net.
"use strict";

// A unit cap of UNLIMITED (1000000) means no cap: the pages show "Unlimited".
const UNLIMITED = 1000000;
// `prices` is the explicit table { months: EGP } a plan is sold for; a period missing from it is not offered
// (the 6 and 12 month prices are not a formula: they are rounded by hand).
const PLANS = [
  { id: "solo", name: ["سولو", "Solo"], priceEgp: 199, seats: 1, units: 1000, credits: 400, prices: { 1: 199, 6: 1075, 12: 1990 } },
  { id: "team", name: ["فريق", "Team"], priceEgp: 599, seats: 5, units: 5000, credits: 2000, prices: { 1: 599, 6: 3235, 12: 5990 } },
  { id: "office", name: ["مكتب", "Office"], priceEgp: 1790, seats: 15, units: UNLIMITED, credits: 6000, prices: { 1: 1790, 6: 9666, 12: 17900 } },
  // Agency is sold up front only (no monthly price). Enterprise (6: 29,900, 12: 53,900) is contact-only and not in this list.
  { id: "agency", name: ["شركة", "Agency"], priceEgp: 2990, seats: 25, units: UNLIMITED, credits: 10000, prices: { 6: 16146, 12: 29900 } }
];
// A small plan that keeps every record readable (never deleted) with a little room to keep working (agencies whose period ended).
const FREE = { id: "free", name: ["مجاني", "Free"], priceEgp: 0, seats: 1, units: 50, credits: 80, prices: {} };
// The self sign-up trial: 1 seat, 50 units and 80 AI credits. Never sold (not in PLANS, no prices).
const TRIAL_PLAN = { id: "trial", name: ["تجربة", "Trial"], priceEgp: 0, seats: 1, units: 50, credits: 80, prices: {} };
// Extra credits bought for the month: { id, name: [ar, en], priceEgp, credits }.
const BUNDLES = [
  { id: "small", name: ["باقة صغيرة", "Small"], priceEgp: 99, credits: 200 },
  { id: "medium", name: ["باقة متوسطة", "Medium"], priceEgp: 229, credits: 500 },
  { id: "large", name: ["باقة كبيرة", "Large"], priceEgp: 399, credits: 1000 },
  { id: "agency", name: ["باقة الشركات", "Agency Pack"], priceEgp: 899, credits: 2500 }
];
// The trial: 14 days on the 'trial' plan (1 seat, 50 units, 80 AI credits).
const TRIAL = Object.freeze({ plan: "trial", days: 14, seats: 1, units: 50, credits: 80 });

const ALL = [...PLANS, FREE, TRIAL_PLAN];
const planById = (id) => ALL.find((p) => p.id === id) || null;
const planName = (plan, lang) => plan.name[lang === "en" ? 1 : 0];
const bundleById = (id) => BUNDLES.find((b) => b.id === id) || null;

/** The periods (months, ascending) a plan is sold for: [] for a plan with no price table (trial, free). */
const periodsOf = (plan) => Object.keys(plan?.prices || {}).map(Number).sort((a, b) => a - b);
/** Price of a plan for a period in EGP, or null when the plan is not sold for that period. */
const priceFor = (plan, months) => {
  const n = plan?.prices?.[Number(months)];
  return Number.isFinite(n) ? n : null;
};
/** Per-month equivalent of a period price, rounded (6 months for 1,075 is ~179 a month). */
const perMonth = (price, months) => Math.round(price / months);

/** The tier of a sold plan (0 = the cheapest); -1 for a plan that is not sold (trial, free, unknown). Upgrades only go to a higher tier. */
const tierOf = (id) => PLANS.findIndex((p) => p.id === id);

// The hidden admin override (services/billing.js addExtraSeats): 1 to 4 extra seats mid-contract, billed up front for the
// remaining months; each seat also adds credits to the monthly pool.
const EXTRA_SEAT = Object.freeze({ priceEgp: 180, credits: 400, max: 4 });

/** Fills the plans and bundles in place from database rows (credit_plans, credit_bundles). */
function hydrate({ plans = [], bundles = [] } = {}) {
  const prices = (v) => {
    const o = typeof v === "string" ? JSON.parse(v) : v || {};
    return Object.fromEntries(Object.entries(o).map(([m, n]) => [Number(m), Number(n)]));
  };
  const shape = (r) => ({ id: r.id, name: [r.name_ar, r.name_en], priceEgp: r.price_egp, seats: r.seats, units: r.units, credits: r.credits, prices: prices(r.prices) });
  const paid = plans.filter((r) => r.id !== "free" && r.id !== "trial" && r.active).sort((a, b) => a.sort - b.sort || a.price_egp - b.price_egp).map(shape);
  const free = plans.find((r) => r.id === "free");
  const trial = plans.find((r) => r.id === "trial");
  if (paid.length) PLANS.splice(0, PLANS.length, ...paid);
  if (free) Object.assign(FREE, shape(free));
  if (trial) Object.assign(TRIAL_PLAN, shape(trial));
  if (bundles.length) BUNDLES.splice(0, BUNDLES.length, ...bundles.map((r) => ({ id: r.id, name: [r.name_ar, r.name_en], priceEgp: r.price_egp, credits: r.credits })));
  ALL.splice(0, ALL.length, ...PLANS, FREE, TRIAL_PLAN);
}

/** What a broker is told when the plan's unit cap is reached (limit = { used, limit, plan }). */
function unitLimitText(limit, lang = "ar") {
  const n = Number(limit.limit).toLocaleString("en-US");
  const name = planName(limit.plan, lang);
  return lang === "en"
    ? `⛔ Your ${name} plan holds ${n} units (available, archived and sold) and you have reached it. Delete units you no longer need, or upgrade from the Plan page (/app/plan).`
    : `⛔ وصلت للحد الأقصى لباقة ${name}: ${n} وحدة (المتاحة والمؤرشفة والمباعة). امسح الوحدات اللي مش محتاجها، أو رقّي الباقة من صفحة الباقة (/app/plan).`;
}

module.exports = { UNLIMITED, unitLimitText, hydrate, periodsOf, priceFor, perMonth, tierOf, EXTRA_SEAT, ALL, PLANS, FREE, TRIAL_PLAN, BUNDLES, TRIAL, planById, planName, bundleById };
