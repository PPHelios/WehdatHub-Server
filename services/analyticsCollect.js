// services/analyticsCollect.js — The nightly market analytics job (`analytics_nightly`). After 02:00 Cairo, once a day (a sleeping
// instance catches up when it wakes), it (1) counts the finished days of search_log, (2) writes the market cells of the day just ended
// (analytics_market_daily) and (3) rewrites this month's and last month's funnel (analytics_funnel_monthly). Idempotent: day and month
// rows are replaced, search counts move forward with a marker. It reads compact rows with no personal fields, aggregates them in
// domain/analytics*.js (privacy thresholds applied there, at write time) and has a hard time and row budget; going over either throws,
// so the scheduler's error path reports it and the next tick retries. Counts only are logged.
"use strict";

const Bands = require("../domain/analyticsBands");
const Market = require("../domain/analyticsMarket");
const Funnel = require("../domain/analyticsFunnel");
const Privacy = require("../domain/analyticsPrivacy");
const Search = require("./analyticsSearch");
const Vis = require("../lib/visibility");

const NIGHT_HOUR = 2; // Cairo
const MAX_MS = 60 * 1000; // wall-clock budget for one run
const MAX_ROWS = 150000; // unit rows / lead rows read per step
const INSERT_BATCH = 200;

const overBudget = (deadline) => Date.now() > deadline;
const assertTime = (deadline, step) => {
  if (overBudget(deadline)) throw new Error(`analytics_time_budget:${step}`);
};

/** Multi-row insert in batches: columns and rows (arrays), one statement per batch. */
async function insertRows(client, table, cols, rows) {
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const part = rows.slice(i, i + INSERT_BATCH);
    const params = [];
    const values = part.map((r) => `(${cols.map((c) => (params.push(r[c]), `$${params.length}`)).join(", ")})`);
    await client.query(`INSERT INTO ${table} (${cols.join(", ")}) VALUES ${values.join(", ")}`, params);
  }
}

async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const MARKET_COLS = ["day", "area_id", "property_type", "listing_type", "bedroom_band", "listings_active", "new_listings", "removed_listings", "price_m2_p25", "price_m2_p50", "price_m2_p75", "price_p50", "sold_count", "median_days_to_close", "asking_vs_closed_pct", "agencies_n", "rows_n"];

/** The unit rows of one Cairo day (no personal fields): what is active now, what was created or left the market that day. */
async function marketRows(pool, day) {
  const next = Bands.addDays(day, 1);
  const { rows } = await pool.query(
    `WITH ev AS (
       SELECT listing_id,
              bool_or(to_status IN ('sold', 'archived', 'deleted') AND from_status IS DISTINCT FROM to_status) AS removed,
              bool_or(to_status = 'sold' AND NOT approx) AS sold,
              (array_agg(at ORDER BY at DESC) FILTER (WHERE to_status = 'sold' AND NOT approx))[1] AS sold_at,
              (array_agg(price_at_change ORDER BY at DESC) FILTER (WHERE to_status = 'sold' AND NOT approx))[1] AS sold_price
         FROM listing_status_events
        WHERE at >= ($1::date)::timestamp AT TIME ZONE 'Africa/Cairo' AND at < ($2::date)::timestamp AT TIME ZONE 'Africa/Cairo'
        GROUP BY listing_id)
     SELECT l.agency_id, l.area_id, a.parent_id, l.property_type, l.listing_type, l.bedrooms,
            CASE WHEN coalesce(l.details->>'currency', 'EGP') = 'EGP' THEN l.price_value END AS price,
            l.area_value AS area_m2,
            (l.status = 'active' AND l.deleted_at IS NULL) AS active,
            (l.created_at >= ($1::date)::timestamp AT TIME ZONE 'Africa/Cairo' AND l.created_at < ($2::date)::timestamp AT TIME ZONE 'Africa/Cairo') AS is_new,
            coalesce(ev.removed, false) AS removed, coalesce(ev.sold, false) AS sold,
            CASE WHEN ev.sold THEN EXTRACT(EPOCH FROM (ev.sold_at - l.created_at)) / 86400 END AS days_to_close,
            CASE WHEN ev.sold AND ev.sold_price > 0 THEN
              (SELECT round(100.0 * (d.price - ev.sold_price) / ev.sold_price, 2) FROM deals d WHERE d.listing_id = l.id AND d.status <> 'cancelled' ORDER BY d.closed_at DESC LIMIT 1) END AS ask_gap_pct
       FROM listings l LEFT JOIN areas a ON a.id = l.area_id LEFT JOIN ev ON ev.listing_id = l.id
      WHERE ${Vis.allUnits()} AND l.market = 'resale' AND NOT l.is_private
        AND ((l.status = 'active' AND l.deleted_at IS NULL) OR ev.listing_id IS NOT NULL
             OR (l.created_at >= ($1::date)::timestamp AT TIME ZONE 'Africa/Cairo' AND l.created_at < ($2::date)::timestamp AT TIME ZONE 'Africa/Cairo'))
      LIMIT ${MAX_ROWS + 1}`,
    [day, next]
  );
  if (rows.length > MAX_ROWS) throw new Error("analytics_market_row_budget");
  return rows.map((r) => ({
    agency_id: r.agency_id, area_id: r.area_id, parent_id: r.parent_id, property_type: r.property_type || "all", listing_type: r.listing_type,
    bedroom_band: Bands.bedroomBand(r.bedrooms), price: r.price === null ? null : Number(r.price), area_m2: r.area_m2 === null ? null : Number(r.area_m2),
    active: r.active, is_new: r.is_new, removed: r.removed, sold: r.sold,
    days_to_close: r.days_to_close === null ? null : Number(r.days_to_close), ask_gap_pct: r.ask_gap_pct === null ? null : Number(r.ask_gap_pct)
  }));
}

/** Writes the market cells of one day (the day's rows are replaced). → number of cells written. */
async function runMarket(pool, day) {
  const cells = Market.computeCells(await marketRows(pool, day), day);
  Privacy.assertClean(cells);
  await tx(pool, async (client) => {
    await client.query("DELETE FROM analytics_market_daily WHERE day = $1::date", [day]);
    await insertRows(client, "analytics_market_daily", MARKET_COLS, cells);
  });
  return cells.length;
}

const FUNNEL_COLS = ["month", "agency_id", "leads", "contacted", "viewings", "deals", "lost", "median_first_response_minutes", "by_source", "lost_reasons", "rates", "agencies_n"];

/** Writes the funnel of one month (YYYY-MM-01): one row per agency and the market row when it is big enough. → rows written. */
async function runFunnel(pool, month) {
  const next = `${Bands.addDays(month, 32).slice(0, 7)}-01`;
  const from = `($1::date)::timestamp AT TIME ZONE 'Africa/Cairo'`;
  const to = `($2::date)::timestamp AT TIME ZONE 'Africa/Cairo'`;
  const leads = await pool.query(
    `SELECT l.agency_id, (l.last_contact_at IS NOT NULL OR l.stage <> 'new') AS contacted, (l.stage IN ('viewing', 'negotiation', 'won')) AS viewed,
            (l.stage = 'lost') AS lost, l.source, l.lost_reason,
            (SELECT EXTRACT(EPOCH FROM (min(e.created_at) - l.created_at)) / 60 FROM lead_events e WHERE e.lead_id = l.id AND e.kind = 'contacted' AND e.undone_at IS NULL) AS response_min
       FROM leads l WHERE ${Vis.allLeads()} AND l.created_at >= ${from} AND l.created_at < ${to} LIMIT ${MAX_ROWS + 1}`,
    [month, next]
  );
  if (leads.rows.length > MAX_ROWS) throw new Error("analytics_funnel_row_budget");
  const deals = await pool.query(`SELECT agency_id, count(*)::int AS n FROM deals WHERE closed_at >= ${from} AND closed_at < ${to} AND status <> 'cancelled' GROUP BY agency_id`, [month, next]);
  const dealsBy = Object.fromEntries(deals.rows.map((r) => [r.agency_id, r.n]));
  const mine = Funnel.agencyRows(
    leads.rows.map((r) => ({ agency_id: r.agency_id, contacted: r.contacted, viewed: r.viewed, lost: r.lost, source: r.source, lost_reason: r.lost_reason, response_min: r.response_min === null ? null : Number(r.response_min) })),
    dealsBy, month
  );
  const market = Funnel.marketRow(mine, month);
  const all = market ? [...mine, market] : mine;
  Privacy.assertClean(all);
  await tx(pool, async (client) => {
    await client.query("DELETE FROM analytics_funnel_monthly WHERE month = $1::date", [month]);
    await insertRows(client, "analytics_funnel_monthly", FUNNEL_COLS, all.map((r) => ({ ...r, by_source: JSON.stringify(r.by_source), lost_reasons: JSON.stringify(r.lost_reasons), rates: JSON.stringify(r.rates) })));
  });
  return all.length;
}

/** Row counts of the analytics tables (shown on the owner's tab). */
async function tableCounts(pool) {
  const { rows } = await pool.query(`SELECT
    (SELECT count(*)::int FROM analytics_search_daily) AS search_daily, (SELECT count(*)::int FROM analytics_market_daily) AS market_daily,
    (SELECT count(*)::int FROM analytics_funnel_monthly) AS funnel_monthly, (SELECT count(*)::int FROM listing_status_events) AS status_events,
    (SELECT count(*)::int FROM listing_prices) AS price_history`);
  return rows[0];
}

/**
 * One run (the job body). `force` ignores the night-hour and "already done today" checks (manual rerun).
 * @returns {{ counts: Object, watermark?: Object }}
 */
async function runOnce(pool, { now = new Date(), watermark = {}, force = false } = {}) {
  const today = Bands.cairoDay(now);
  if (!force) {
    if (watermark.day === today) return { counts: {} };
    if (watermark.day && Bands.cairoHour(now) < NIGHT_HOUR) return { counts: {} }; // wait for the night
  }
  const t0 = Date.now();
  const deadline = t0 + MAX_MS;
  const counts = {};
  const searches = await Search.rollThrough(pool, { now });
  counts.search_days = searches.days;
  counts.search_rows = searches.searches;
  assertTime(deadline, "search");
  counts.market_cells = await runMarket(pool, Bands.addDays(today, -1));
  assertTime(deadline, "market");
  const thisMonth = `${today.slice(0, 7)}-01`;
  const lastMonth = `${Bands.addDays(thisMonth, -1).slice(0, 7)}-01`;
  counts.funnel_rows = (await runFunnel(pool, lastMonth)) + (await runFunnel(pool, thisMonth));
  assertTime(deadline, "funnel");
  const tables = await tableCounts(pool);
  await pool.query(
    `INSERT INTO analytics_meta (key, value, updated_at) VALUES ('last_run', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify({ at: now.toISOString(), day: today, ms: Date.now() - t0, counts, tables })]
  );
  return { counts, watermark: { day: today } };
}

/** The scheduler job (lib/jobs.js): checked every 3 hours, runs once a day after 02:00 Cairo. */
function analyticsJob() {
  return { name: "analytics_nightly", everyMs: 3 * 3600 * 1000, run: ({ pool, now, watermark }) => runOnce(pool, { now: now || new Date(), watermark: watermark || {} }) };
}

module.exports = { analyticsJob, runOnce, runMarket, runFunnel, tableCounts, NIGHT_HOUR, MAX_MS, MAX_ROWS };
