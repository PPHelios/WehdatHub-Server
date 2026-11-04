// services/adminBoard.js — The owner's board: seven tabs of numbers, computed nightly and on a manual refresh (one per
// tab, at most every 10 minutes), then read from stored rows. Numbers only: no client names or phones. Money figures are
// estimates: AI cost is the logged estimate converted at ADMIN_USD_EGP (default 60) and fixed costs are what the owner
// enters. Owner only (services/dashboards.js isOwner); the page and the refresh are checked in the route.
"use strict";

const Credits = require("./credits");
const Signup = require("./signup");
const Vis = require("../lib/visibility");

const DAY = 24 * 3600 * 1000;
const TABS = ["overview", "money", "ai", "performance", "search", "agencies", "operations"];
const PERIODS = [7, 30, 90];
const REFRESH_COOLDOWN_MS = 10 * 60 * 1000;

const usdToEgp = () => Number(process.env.ADMIN_USD_EGP) > 0 ? Number(process.env.ADMIN_USD_EGP) : 60;
const round = (n, d = 2) => Math.round((Number(n) || 0) * 10 ** d) / 10 ** d;
const pct = (part, whole) => (whole > 0 ? round((100 * part) / whole, 1) : 0);

async function rows(pool, sql, params = []) {
  return (await pool.query(sql, params)).rows;
}

async function paidIn(pool, since) {
  const [r] = await rows(pool, "SELECT coalesce(sum(amount_egp), 0)::float AS egp FROM payments WHERE status = 'confirmed' AND confirmed_at >= $1", [since]);
  return r.egp;
}

async function aiTotals(pool, since) {
  const [r] = await rows(pool, `SELECT coalesce(sum(estimated_cost_usd), 0)::float AS usd, count(*)::int AS calls
    FROM operation_logs WHERE created_at >= $1 AND model_used IS NOT NULL`, [since]);
  return { usd: round(r.usd, 4), egp: round(r.usd * usdToEgp()), calls: r.calls };
}

async function computeOverview(pool, since) {
  const [ai, paid] = [await aiTotals(pool, since), await paidIn(pool, since)];
  const [counts] = await rows(pool, `SELECT
      (SELECT count(DISTINCT agency_id)::int FROM operation_logs WHERE created_at >= $1 AND broker_id IS NOT NULL) AS agencies,
      (SELECT count(DISTINCT broker_id)::int FROM operation_logs WHERE created_at >= $1 AND broker_id IS NOT NULL) AS brokers,
      (SELECT count(*)::int FROM listings WHERE ${Vis.allUnits()} AND created_at >= $1) AS units,
      (SELECT count(*)::int FROM leads WHERE ${Vis.allLeads()} AND created_at >= $1) AS leads,
      (SELECT count(*)::int FROM error_events WHERE created_at >= $1 AND kind = 'error') AS errors`, [since]);
  return { paidInEgp: round(paid), aiUsd: ai.usd, aiEgp: ai.egp, aiCalls: ai.calls, ...counts };
}

async function computeMoney(pool, since, now) {
  const paid = await paidIn(pool, since);
  const ai = await aiTotals(pool, since);
  const [fixed] = await rows(pool, "SELECT coalesce(sum(amount_egp), 0)::float AS egp FROM fixed_costs WHERE month >= date_trunc('month', $1::timestamptz)::date AND month <= $2::date", [since, now.toISOString().slice(0, 10)]);
  const [pending] = await rows(pool, "SELECT count(*)::int AS n FROM payments WHERE confirmed_at IS NULL");
  const fixedEgp = round(fixed.egp);
  return {
    paidInEgp: round(paid),
    aiEgp: ai.egp,
    fixedEgp,
    netEgp: round(paid - ai.egp - fixedEgp),
    pendingPayments: pending.n,
    note: "AI cost is an estimate at ADMIN_USD_EGP; fixed costs are the ones entered in the Money tab."
  };
}

async function computeAi(pool, since, now) {
  const perAgency = await rows(pool, `SELECT a.id, a.name, a.plan, count(o.*)::int AS calls,
      count(o.*) FILTER (WHERE o.status = 'failed')::int AS failed, coalesce(sum(o.estimated_cost_usd), 0)::float AS usd
    FROM agencies a LEFT JOIN operation_logs o ON o.agency_id = a.id AND o.created_at >= $1 AND o.model_used IS NOT NULL
    GROUP BY a.id, a.name, a.plan ORDER BY usd DESC, a.name`, [since]);
  const total = await aiTotals(pool, since);
  const agencies = [];
  for (const a of perAgency) {
    // Quota: this month's credits used against the agency's pool (plan + bundles + grants), as the agency sees them.
    const used = await Credits.usedThisMonth(pool, a.id, { now });
    const pool_ = await Credits.poolFor(pool, a.id, a.plan, { now });
    agencies.push({ id: a.id, name: a.name, plan: a.plan, calls: a.calls, failed: a.failed, usd: round(a.usd, 4), egp: round(a.usd * usdToEgp()), sharePct: pct(a.usd, total.usd), quotaUsed: used, quotaTotal: pool_.total, quotaPct: pct(used, pool_.total) });
  }
  const actions = (await rows(pool, `SELECT operation_type AS action, count(*)::int AS calls, coalesce(sum(estimated_cost_usd), 0)::float AS usd
    FROM operation_logs WHERE created_at >= $1 AND model_used IS NOT NULL GROUP BY 1 ORDER BY usd DESC, calls DESC LIMIT 20`, [since])).map((r) => ({
    action: r.action, calls: r.calls, usd: round(r.usd, 4), egp: round(r.usd * usdToEgp()), sharePct: pct(r.usd, total.usd)
  }));
  return { totalUsd: total.usd, totalEgp: total.egp, totalCalls: total.calls, agencies, actions };
}

async function computePerformance(pool, since) {
  const byAction = (await rows(pool, `SELECT operation_type AS action, count(*)::int AS calls, count(*) FILTER (WHERE status = 'failed')::int AS failed,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY total_duration_ms) FILTER (WHERE total_duration_ms IS NOT NULL)::float AS p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY total_duration_ms) FILTER (WHERE total_duration_ms IS NOT NULL)::float AS p95
    FROM operation_logs WHERE created_at >= $1 GROUP BY 1 ORDER BY calls DESC LIMIT 25`, [since])).map((r) => ({ action: r.action, calls: r.calls, failed: r.failed, errorPct: pct(r.failed, r.calls), p50Ms: round(r.p50, 0), p95Ms: round(r.p95, 0) }));
  const [delays] = await rows(pool, `SELECT round(avg(gemini_ms))::int AS ai_ms, round(avg(db_ms))::int AS db_ms, round(avg(media_download_ms))::int AS media_ms,
      round(avg(flyer_render_ms))::int AS flyer_ms, round(avg(storage_upload_ms))::int AS storage_ms FROM operation_logs WHERE created_at >= $1`, [since]);
  return { byAction, avgMs: delays };
}

async function computeSearch(pool, since) {
  const [t] = await rows(pool, `SELECT count(*)::int AS total,
      count(*) FILTER (WHERE total = 0)::int AS no_result,
      count(*) FILTER (WHERE cardinality(disagree) > 0)::int AS disagreed,
      count(*) FILTER (WHERE cardinality(asked) > 0)::int AS asked,
      count(*) FILTER (WHERE guesses IS NOT NULL)::int AS guessed,
      count(*) FILTER (WHERE ai_error IS NOT NULL)::int AS ai_errors
    FROM search_log WHERE created_at >= $1`, [since]);
  const bySource = await rows(pool, "SELECT coalesce(source, 'unknown') AS source, count(*)::int AS n FROM search_log WHERE created_at >= $1 GROUP BY 1 ORDER BY n DESC", [since]);
  const [rep] = await rows(pool, "SELECT count(*)::int AS n FROM search_reports WHERE created_at >= $1", [since]);
  const asked = await rows(pool, "SELECT w, count(*)::int AS n FROM search_log, unnest(asked) AS w WHERE created_at >= $1 GROUP BY w ORDER BY n DESC LIMIT 15", [since]);
  const disagree = await rows(pool, "SELECT f, count(*)::int AS n FROM search_log, unnest(disagree) AS f WHERE created_at >= $1 GROUP BY f ORDER BY n DESC LIMIT 10", [since]);
  const guesses = await rows(pool, `SELECT g->>'typed' AS typed, g->>'as' AS as_place, count(*)::int AS n
    FROM search_log, jsonb_array_elements(guesses) AS g WHERE created_at >= $1 AND guesses IS NOT NULL GROUP BY 1, 2 ORDER BY n DESC LIMIT 15`, [since]);
  return {
    total: t.total, noResult: t.no_result, noResultPct: pct(t.no_result, t.total), disagreed: t.disagreed, asked: t.asked, guessed: t.guessed, aiErrors: t.ai_errors, reports: rep.n,
    bySource, askedWords: asked, disagreedFilters: disagree, guessedSpellings: guesses.map((g) => ({ typed: g.typed, as: g.as_place, n: g.n }))
  };
}

async function computeAgencies(pool, since) {
  const list = await rows(pool, `SELECT a.id, a.name, a.plan,
      (SELECT count(*)::int FROM brokers b WHERE b.agency_id = a.id AND b.is_active) AS brokers,
      (SELECT max(b.last_active_at) FROM brokers b WHERE b.agency_id = a.id) AS last_active,
      (SELECT count(*)::int FROM listings l WHERE ${Vis.allUnits()} AND l.agency_id = a.id AND l.created_at >= $1) AS units,
      (SELECT count(*)::int FROM leads l WHERE ${Vis.allLeads()} AND l.agency_id = a.id AND l.created_at >= $1) AS leads,
      (SELECT count(DISTINCT o.broker_id)::int FROM operation_logs o WHERE o.agency_id = a.id AND o.created_at >= $1 AND o.broker_id IS NOT NULL) AS active_brokers,
      (SELECT coalesce(sum(o.estimated_cost_usd), 0)::float FROM operation_logs o WHERE o.agency_id = a.id AND o.created_at >= $1) AS usd
    FROM agencies a ORDER BY a.name`, [since]);
  return list.map((a) => ({ id: a.id, name: a.name, plan: a.plan, brokers: a.brokers, lastActive: a.last_active, units: a.units, leads: a.leads, activeBrokers: a.active_brokers, aiEgp: round(a.usd * usdToEgp()) }));
}

async function computeOperations(pool, since) {
  const [errs] = await rows(pool, `SELECT count(*) FILTER (WHERE kind = 'error' AND resolved_at IS NULL)::int AS open_errors,
      count(*) FILTER (WHERE kind = 'report' AND resolved_at IS NULL)::int AS open_reports FROM error_events WHERE created_at >= $1`, [since]);
  const [pay] = await rows(pool, "SELECT count(*)::int AS n FROM payments WHERE confirmed_at IS NULL");
  const credits = await Credits.pendingRequests(pool);
  const signups = await Signup.pending(pool);
  return { openErrors: errs.open_errors, openReports: errs.open_reports, pendingPayments: pay.n, pendingCreditRequests: credits.length, pendingSignups: signups.length };
}

const COMPUTE = {
  overview: (pool, since) => computeOverview(pool, since),
  money: (pool, since, now) => computeMoney(pool, since, now),
  ai: (pool, since, now) => computeAi(pool, since, now),
  performance: (pool, since) => computePerformance(pool, since),
  search: (pool, since) => computeSearch(pool, since),
  agencies: (pool, since) => computeAgencies(pool, since),
  operations: (pool, since) => computeOperations(pool, since)
};

/** Computes one tab for every period and stores each result. */
async function computeTab(pool, tab, now = new Date()) {
  for (const days of PERIODS) {
    const since = new Date(now.getTime() - days * DAY).toISOString();
    const data = await COMPUTE[tab](pool, since, now);
    await pool.query(
      `INSERT INTO admin_board_snapshots (tab, period_days, payload, computed_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tab, period_days) DO UPDATE SET payload = EXCLUDED.payload, computed_at = EXCLUDED.computed_at`,
      [tab, days, JSON.stringify({ data, since }), now.toISOString()]
    );
  }
}

/** Every tab, every period (the nightly job). */
async function computeAll(pool, now = new Date()) {
  for (const tab of TABS) await computeTab(pool, tab, now);
  return TABS.length;
}

/**
 * Manual refresh of one tab. Refused within 10 minutes of the last computation of that tab unless `force` (the Money tab
 * is recomputed after a fixed cost is added). Returns { ok: true } or { error: "cooldown", retryAt }.
 */
async function refreshTab(pool, tab, { now = new Date(), force = false } = {}) {
  if (!TABS.includes(tab)) return { error: "unknown_tab" };
  const [last] = await rows(pool, "SELECT max(computed_at) AS at FROM admin_board_snapshots WHERE tab = $1", [tab]);
  const at = last && last.at ? new Date(last.at).getTime() : 0;
  if (!force && at && now.getTime() - at < REFRESH_COOLDOWN_MS) return { error: "cooldown", retryAt: new Date(at + REFRESH_COOLDOWN_MS).toISOString() };
  await computeTab(pool, tab, now);
  return { ok: true };
}

/** The stored result of one tab for one period: { data, since, computedAt } or null when never computed. */
async function readTab(pool, tab, days) {
  const [r] = await rows(pool, "SELECT payload, computed_at FROM admin_board_snapshots WHERE tab = $1 AND period_days = $2", [tab, days]);
  if (!r) return null;
  return { data: r.payload.data, since: r.payload.since, computedAt: new Date(r.computed_at).toISOString() };
}

/** Cash flow: fixed costs entered by the owner. month is YYYY-MM. */
async function addFixedCost(pool, { month, label, amount }) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ""))) return { error: "month" };
  const text = String(label || "").trim();
  if (!text || text.length > 120) return { error: "label" };
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0 || n > 1e9) return { error: "amount" };
  await pool.query("INSERT INTO fixed_costs (month, label, amount_egp) VALUES ($1::date, $2, $3)", [`${month}-01`, text, n]);
  await refreshTab(pool, "money", { force: true });
  return { ok: true };
}

async function deleteFixedCost(pool, id) {
  const { rowCount } = await pool.query("DELETE FROM fixed_costs WHERE id = $1", [id]);
  await refreshTab(pool, "money", { force: true });
  return rowCount > 0;
}

async function listFixedCosts(pool) {
  return rows(pool, "SELECT id, to_char(month, 'YYYY-MM') AS month, label, amount_egp::float AS amount FROM fixed_costs ORDER BY month DESC, created_at DESC LIMIT 60");
}

/** Nightly job: computes every tab (once a day; a sleeping instance catches up on wake). */
function adminBoardJob() {
  return { name: "admin_board_nightly", everyMs: DAY, run: async ({ pool, now }) => ({ counts: { tabs: await computeAll(pool, now || new Date()) } }) };
}

module.exports = { TABS, PERIODS, REFRESH_COOLDOWN_MS, computeAll, computeTab, refreshTab, readTab, addFixedCost, deleteFixedCost, listFixedCosts, adminBoardJob, usdToEgp };
