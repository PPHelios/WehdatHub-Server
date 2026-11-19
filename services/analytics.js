// services/analytics.js — The only reader of the market analytics tables. Every read here is checked: the owner (OWNER_BROKER_IDS)
// reads everything; an agency's managers and owner read only while the owner has switched analytics on for that agency
// (agencies.analytics_enabled), only their OWN funnel row (the agency id comes from the signed-in person, never from the request)
// plus the market rows, and market reports only for the places where the agency has units. Brokers and data entry are refused.
// The tables hold counts, bands and medians only (written by services/analyticsCollect.js under domain/analyticsPrivacy.js).
"use strict";

const Authz = require("../lib/authz");
const Privacy = require("../domain/analyticsPrivacy");
const Vis = require("../lib/visibility");
const { logOperation } = require("../lib/db");

const MONTHS = 12;
const TOP = 40;

const isPlatformOwner = (broker) => require("./dashboards").isOwner(broker);
/** Managers and the agency owner (not brokers, team leads, data entry or the product owner's tracking account). */
const isAgencyManager = (broker) => Boolean(broker?.agency_id) && Authz.isManager(broker) && !Authz.isDataEntry(broker) && !Authz.isCrmOwner(broker);

async function isEnabled(pool, agencyId) {
  if (!agencyId) return false;
  const { rows } = await pool.query("SELECT analytics_enabled FROM agencies WHERE id = $1", [agencyId]);
  return Boolean(rows[0] && rows[0].analytics_enabled);
}

/** 'ok' | 'forbidden' (wrong role) | 'disabled' (the switch is off). */
async function gate(pool, broker) {
  if (!isAgencyManager(broker)) return "forbidden";
  return (await isEnabled(pool, broker.agency_id)) ? "ok" : "disabled";
}

/** Owner: switch analytics on or off for one agency. → { ok, enabled } | { error: "not_found" } */
async function setEnabled(pool, owner, agencyId, on) {
  if (!isPlatformOwner(owner)) return { error: "forbidden" };
  const { rows } = await pool.query("UPDATE agencies SET analytics_enabled = $2, updated_at = now() WHERE id = $1 RETURNING analytics_enabled", [agencyId, Boolean(on)]);
  if (!rows[0]) return { error: "not_found" };
  require("../lib/workspace").forget(agencyId); // the menu reads the flag from the cached workspace state
  logOperation(pool, { agency_id: agencyId, broker_id: owner.id, operation_type: "owner_analytics", status: "success", metadata: { enabled: rows[0].analytics_enabled } });
  return { ok: true, enabled: rows[0].analytics_enabled };
}

/** Last run time and the row counts of the analytics tables. */
async function status(pool) {
  const { rows } = await pool.query("SELECT value, updated_at FROM analytics_meta WHERE key = 'last_run'");
  const job = (await pool.query("SELECT last_finished_at, last_status, last_error FROM crm_jobs WHERE name = 'analytics_nightly'")).rows[0] || null;
  const run = rows[0] ? rows[0].value : null;
  return { lastRunAt: run ? run.at : null, counts: run ? run.counts : null, tables: run ? run.tables : null, ms: run ? run.ms : null, job: job ? { status: job.last_status, finishedAt: job.last_finished_at, error: job.last_error } : null };
}

/** Agencies with their switch (the owner's list). */
async function agencySwitches(pool) {
  return (await pool.query("SELECT id, name, analytics_enabled FROM agencies WHERE approval <> 'rejected' ORDER BY name")).rows;
}

/** The area ids (and their parents) where an agency has active units. */
async function agencyAreaIds(pool, agencyId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT x.id FROM (
       SELECT a.id FROM listings l JOIN areas a ON a.id = l.area_id WHERE ${Vis.allUnits()} AND l.agency_id = $1 AND l.status = 'active' AND l.deleted_at IS NULL
       UNION SELECT a.parent_id FROM listings l JOIN areas a ON a.id = l.area_id WHERE ${Vis.allUnits()} AND l.agency_id = $1 AND l.status = 'active' AND l.deleted_at IS NULL AND a.parent_id IS NOT NULL) x`,
    [agencyId]
  );
  return rows.map((r) => r.id);
}

const place = (r) => ({ area_id: r.area_id, name_ar: r.name_ar || null, name_en: r.name_en || null });
const keyOf = (r) => `${r.area_id}|${r.property_type}|${r.listing_type}`;

/** The market reports. areaIds: null = every place, else only those places. */
async function marketReports(pool, { areaIds = null, now = new Date() } = {}) {
  const ids = areaIds && areaIds.length ? areaIds : null;
  if (areaIds && !areaIds.length) return emptyReports();
  const since = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const since90 = new Date(now.getTime() - 90 * 86400000).toISOString().slice(0, 10);
  const sinceMonths = new Date(now.getTime() - MONTHS * 31 * 86400000).toISOString().slice(0, 10);
  const latest = (await pool.query("SELECT max(day)::text AS d FROM analytics_market_daily")).rows[0].d;
  const f = ids ? "AND m.area_id = ANY($2::uuid[])" : "";
  const arg = (a) => (ids ? [a, ids] : [a]);

  // Supply on the latest day, then demand from the last 30 days of searches.
  const supply = latest
    ? (await pool.query(`SELECT m.area_id, m.property_type, m.listing_type, m.listings_active FROM analytics_market_daily m WHERE m.day = $1::date AND m.bedroom_band = 'all' AND m.area_id IS NOT NULL ${f}`, arg(latest))).rows
    : [];
  const supplyBy = new Map(supply.map((r) => [keyOf(r), r.listings_active]));
  const supplyAll = new Map();
  for (const r of supply) {
    const k = `${r.area_id}|any|${r.listing_type}`;
    supplyAll.set(k, (supplyAll.get(k) || 0) + r.listings_active);
  }
  const dem = (await pool.query(
    `SELECT d.area_id, d.property_type, d.listing_type, sum(d.searches)::int AS searches, sum(d.zero_result)::int AS zero, a.name_ar, a.name_en
       FROM analytics_search_daily d JOIN areas a ON a.id = d.area_id
      WHERE d.day >= $1::date AND d.area_id IS NOT NULL ${ids ? "AND d.area_id = ANY($2::uuid[])" : ""}
      GROUP BY d.area_id, d.property_type, d.listing_type, a.name_ar, a.name_en ORDER BY searches DESC LIMIT ${TOP}`, arg(since))).rows;
  const demand = dem.map((r) => {
    const big = r.searches >= Privacy.MIN_SEARCHES;
    const s = r.property_type === "any" ? supplyAll.get(keyOf(r)) : supplyBy.get(keyOf(r));
    return { ...place(r), property_type: r.property_type, listing_type: r.listing_type, suppressed: !big, searches: big ? r.searches : null, zero_result: big ? r.zero : null, zero_pct: big ? Math.round((100 * r.zero) / r.searches) : null, supply: big && s !== undefined ? s : null, hot: big && r.zero >= 3 && r.zero / r.searches >= 0.3 };
  });
  const beds = (await pool.query(
    `SELECT listing_type, bedroom_band, sum(searches)::int AS searches, sum(zero_result)::int AS zero FROM analytics_search_daily
      WHERE day >= $1::date AND bedroom_band <> 'any' ${ids ? "AND area_id = ANY($2::uuid[])" : ""} GROUP BY 1, 2 ORDER BY 1, 2`, arg(since))).rows;
  const demandBeds = beds.map((r) => ({ listing_type: r.listing_type, bedroom_band: r.bedroom_band, suppressed: r.searches < Privacy.MIN_SEARCHES, searches: r.searches >= Privacy.MIN_SEARCHES ? r.searches : null, zero_result: r.searches >= Privacy.MIN_SEARCHES ? r.zero : null }));

  // Price per m² by place with a monthly trend.
  const pr = (await pool.query(
    `SELECT m.area_id, m.property_type, m.listing_type, to_char(date_trunc('month', m.day), 'YYYY-MM') AS month,
            round(avg(m.price_m2_p25)) AS p25, round(avg(m.price_m2_p50)) AS p50, round(avg(m.price_m2_p75)) AS p75, max(m.agencies_n)::int AS agencies_n, a.name_ar, a.name_en
       FROM analytics_market_daily m JOIN areas a ON a.id = m.area_id
      WHERE m.day >= $1::date AND m.bedroom_band = 'all' AND m.price_m2_p50 IS NOT NULL ${f}
      GROUP BY m.area_id, m.property_type, m.listing_type, 4, a.name_ar, a.name_en ORDER BY 4`, arg(sinceMonths))).rows;
  const series = new Map();
  for (const r of pr) {
    const k = keyOf(r);
    if (!series.has(k)) series.set(k, { ...place(r), property_type: r.property_type, listing_type: r.listing_type, trend: [] });
    series.get(k).trend.push({ month: r.month, p25: Number(r.p25), p50: Number(r.p50), p75: Number(r.p75) });
  }
  const prices = [...series.values()].map((s) => ({ ...s, last: s.trend[s.trend.length - 1] })).sort((a, b) => b.trend.length - a.trend.length || b.last.p50 - a.last.p50).slice(0, TOP);

  // Time to close and asking-vs-closed (weighted by closed units), last 90 days.
  const cl = (await pool.query(
    `SELECT m.area_id, m.property_type, m.listing_type, sum(m.sold_count)::int AS sold,
            round(sum(m.median_days_to_close * m.sold_count) / NULLIF(sum(m.sold_count) FILTER (WHERE m.median_days_to_close IS NOT NULL), 0), 1) AS days,
            round(sum(m.asking_vs_closed_pct * m.sold_count) / NULLIF(sum(m.sold_count) FILTER (WHERE m.asking_vs_closed_pct IS NOT NULL), 0), 1) AS gap, a.name_ar, a.name_en
       FROM analytics_market_daily m JOIN areas a ON a.id = m.area_id
      WHERE m.day >= $1::date AND m.bedroom_band = 'all' AND (m.median_days_to_close IS NOT NULL OR m.asking_vs_closed_pct IS NOT NULL) ${f}
      GROUP BY m.area_id, m.property_type, m.listing_type, a.name_ar, a.name_en ORDER BY sold DESC LIMIT ${TOP}`, arg(since90))).rows;
  const closing = cl.map((r) => ({ ...place(r), property_type: r.property_type, listing_type: r.listing_type, sold: r.sold, days: r.days === null ? null : Number(r.days), gap_pct: r.gap === null ? null : Number(r.gap) }));

  // Seasonality: new units and searches per calendar month over the whole market (summed over sale and rent).
  const nl = (await pool.query(
    `SELECT to_char(date_trunc('month', day), 'YYYY-MM') AS month, sum(new_listings)::int AS new_units FROM analytics_market_daily
      WHERE area_id IS NULL AND property_type = 'all' AND bedroom_band = 'all' AND listing_type IN ('sale', 'rent') GROUP BY 1 ORDER BY 1`)).rows;
  const sr = (await pool.query("SELECT to_char(date_trunc('month', day), 'YYYY-MM') AS month, sum(searches)::int AS searches FROM analytics_search_daily GROUP BY 1 ORDER BY 1")).rows;
  const byMonth = new Map();
  for (const r of nl) byMonth.set(r.month, { month: r.month, new_units: r.new_units, searches: null });
  for (const r of sr) byMonth.set(r.month, { month: r.month, new_units: byMonth.get(r.month)?.new_units ?? null, searches: r.searches });
  const seasonality = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)).slice(-24);
  return Privacy.assertClean({ latestDay: latest, demand, demandBeds, prices, closing, seasonality });
}

const emptyReports = () => ({ latestDay: null, demand: [], demandBeds: [], prices: [], closing: [], seasonality: [] });

const FUNNEL_SELECT = `SELECT to_char(month, 'YYYY-MM') AS month, leads, contacted, viewings, deals, lost, median_first_response_minutes AS response_min, by_source, lost_reasons, rates, agencies_n`;

/** The market funnel rows of the last months (agency_id null). */
async function marketFunnel(pool) {
  return (await pool.query(`${FUNNEL_SELECT} FROM analytics_funnel_monthly WHERE agency_id IS NULL ORDER BY month DESC LIMIT 12`)).rows.reverse();
}

/** One agency's own funnel rows of the last months. Internal: callers pass an agency id they have already authorised. */
async function funnelOf(pool, agencyId) {
  return (await pool.query(`${FUNNEL_SELECT} FROM analytics_funnel_monthly WHERE agency_id = $1 ORDER BY month DESC LIMIT 12`, [agencyId])).rows.reverse();
}

/** The owner's view: every report, the market funnel and (when an agency is picked) that agency's funnel. */
async function forOwner(pool, owner, { agencyId = null, now = new Date() } = {}) {
  if (!isPlatformOwner(owner)) return { error: "forbidden" };
  const [reports, market, agencies] = await Promise.all([marketReports(pool, { now }), marketFunnel(pool), agencySwitches(pool)]);
  const pick = agencyId && agencies.some((a) => a.id === agencyId) ? agencyId : null;
  return { reports, marketFunnel: market, agencyFunnel: pick ? await funnelOf(pool, pick) : [], agencyId: pick, agencies };
}

/**
 * An agency's view (managers and owner, switch on): ITS OWN funnel beside the market median, and the market reports for the
 * places where it has units. The agency id is the signed-in person's; there is no way to ask for another agency.
 */
async function forAgency(pool, broker, { now = new Date() } = {}) {
  const g = await gate(pool, broker);
  if (g !== "ok") return { error: g };
  const areaIds = await agencyAreaIds(pool, broker.agency_id);
  const [reports, market, own] = await Promise.all([marketReports(pool, { areaIds, now }), marketFunnel(pool), funnelOf(pool, broker.agency_id)]);
  return { reports, marketFunnel: market, agencyFunnel: own, placesN: areaIds.length };
}

// CSV export (owner only): the aggregate tables, fixed columns, no row-level data exists in them.
const CSV_TABLES = {
  market_daily: { sql: `SELECT m.day::text AS day, m.area_id, a.name_en AS area_en, m.property_type, m.listing_type, m.bedroom_band, m.listings_active, m.new_listings, m.removed_listings, m.price_m2_p25, m.price_m2_p50, m.price_m2_p75, m.price_p50, m.sold_count, m.median_days_to_close, m.asking_vs_closed_pct, m.agencies_n, m.rows_n FROM analytics_market_daily m LEFT JOIN areas a ON a.id = m.area_id ORDER BY m.day, a.name_en NULLS FIRST, m.property_type, m.listing_type, m.bedroom_band` },
  funnel_monthly: { sql: `SELECT to_char(month, 'YYYY-MM') AS month, agency_id, leads, contacted, viewings, deals, lost, median_first_response_minutes, by_source::text AS by_source, lost_reasons::text AS lost_reasons, rates::text AS rates, agencies_n FROM analytics_funnel_monthly ORDER BY month, agency_id NULLS FIRST` },
  search_daily: { sql: `SELECT d.day::text AS day, d.area_id, a.name_en AS area_en, d.property_type, d.listing_type, d.bedroom_band, d.budget_band, d.searches, d.zero_result FROM analytics_search_daily d LEFT JOIN areas a ON a.id = d.area_id ORDER BY d.day, a.name_en NULLS FIRST, d.property_type, d.listing_type, d.bedroom_band, d.budget_band` }
};

const csvCell = (v) => {
  if (v === null || v === undefined) return "";
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`; // spreadsheet formula guard
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV text of one aggregate table (owner only). → { csv } | { error } */
async function exportCsv(pool, owner, table) {
  if (!isPlatformOwner(owner)) return { error: "forbidden" };
  const t = CSV_TABLES[table];
  if (!t) return { error: "unknown_table" };
  const { rows, fields } = await pool.query(`${t.sql} LIMIT 200000`);
  Privacy.assertClean(rows);
  const cols = fields && fields.length ? fields.map((f) => f.name) : Object.keys(rows[0] || {});
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\r\n") + "\r\n";
  return { csv, rows: rows.length };
}

module.exports = { isEnabled, gate, setEnabled, status, agencySwitches, agencyAreaIds, marketReports, marketFunnel, funnelOf, forOwner, forAgency, exportCsv, CSV_TABLES, isAgencyManager };
