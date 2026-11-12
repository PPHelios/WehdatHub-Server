// services/searchAudit.js — The nightly check of the POC's searches. For every search of the last day it looks for:
//   wrong results   units returned that break a number the search used (rooms, price, area, sale or rent);
//   zero results    searches that found nothing;
//   disagreements   the quick reader and the AI read different filters;
//   missed units    units the AI's reading finds that the answer did not include.
// The findings are kept on the search row (search_log.audit) and a short summary goes to the CRM owner on Telegram.
"use strict";

const Search = require("./search");
const Errors = require("../lib/errorReports");
const Vis = require("../lib/visibility");
const Fx = require("./fx");

const KEYS = ["listing_type", "property_types", "places", "price_min", "price_max", "bedrooms_min", "bathrooms_min", "area_min", "area_max", "features", "finishing", "market"];
const norm = (v) => JSON.stringify(Array.isArray(v) ? v.map((x) => (typeof x === "object" ? `${x.kind}:${x.key}` : x)).sort() : v ?? null);

/** Filter names the two readings disagree on. */
function disagreements(a, b) {
  if (!a || !b) return [];
  return KEYS.filter((k) => norm(a[k]) !== norm(b[k]));
}

/** Ids of returned units that break a number in the filters used. */
function badUnits(filters, units) {
  if (!filters) return [];
  const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
  const ceilings = !filters.currency;
  return units
    .filter((u) => {
      if (filters.listing_type && u.listing_type && u.listing_type !== filters.listing_type) return true;
      const bmin = num(filters.bedrooms_min);
      if (bmin !== null && u.bedrooms !== null && Number(u.bedrooms) < bmin) return true;
      const amin = num(filters.area_min);
      if (amin !== null && u.area_value !== null && Number(u.area_value) < amin) return true;
      const amax = num(filters.area_max);
      if (amax !== null && u.area_value !== null && Number(u.area_value) > amax) return true;
      const pmax = num(filters.price_max);
      if (ceilings && pmax !== null && u.price_value !== null && Number(u.price_value) > pmax) return true;
      const pmin = num(filters.price_min);
      if (ceilings && pmin !== null && u.price_value !== null && Number(u.price_value) < pmin) return true;
      return false;
    })
    .map((u) => u.id);
}

// Filter groups: a zero-result search is re-run with one group left out at a time, to show which one emptied the answer.
const GROUPS = {
  listing_type: ["listing_type"],
  property_types: ["property_types"],
  place: ["places", "place_terms", "area_scope"],
  price: ["price_min", "price_max"],
  area: ["area_min", "area_max"],
  bedrooms: ["bedrooms_min", "bedrooms_max"],
  bathrooms: ["bathrooms_min"],
  floor: ["floor_min", "floor_max"],
  finishing: ["finishing"],
  furnishing: ["furnishing"],
  features: ["features", "feature_terms"],
  payment: ["payment_cash", "payment_installments", "payment_years", "payment_down_pct", "max_down_payment", "max_installment"],
  delivery: ["delivery_ready", "delivery_by_year"],
  market: ["market"]
};
const isSet = (v) => v !== null && v !== undefined && v !== false && !(Array.isArray(v) && !v.length);

/** For a search that found nothing: how many units fit when each filter group is left out. Only groups whose removal finds units are kept. */
async function dropOne(pool, agencyId, used) {
  const out = {};
  const fx = await Fx.loadRates(pool, agencyId);
  for (const [group, keys] of Object.entries(GROUPS)) {
    if (!keys.some((k) => isSet(used[k]))) continue;
    const f = { ...used };
    for (const k of keys) f[k] = Array.isArray(used[k]) ? [] : null;
    const { sql, params } = Search.buildSearchQuery(agencyId, { filters: f }, { limit: 1, fx });
    const { rows } = await pool.query(sql, params);
    if (rows.length) out[group] = Number(rows[0].total_count);
  }
  return out;
}

// The check that does not use the search code: the basic facts only (type, place, sale or rent, bedrooms, price, area). When a search
// used nothing else, every unit that fits those facts must be in the answer. Anything else (furnishing, payment, words) is skipped.
const SOFT = ["market", "finishing", "furnishing", "features", "feature_terms", "place_terms", "payment_cash", "payment_installments", "payment_years", "payment_down_pct", "max_down_payment", "max_installment", "delivery_ready", "delivery_by_year", "bathrooms_min", "floor_min", "floor_max", "area_scope", "code"];
async function coreMissed(pool, row) {
  const f = row.used_filters;
  if (!f || row.relaxed || row.asked?.length || Number(row.total) === 0 || Number(row.total) > 45 || (row.result_ids || []).length < Number(row.total)) return [];
  if (SOFT.some((k) => isSet(f[k])) || (f.currency && f.currency !== "EGP")) return [];
  const p = [row.agency_id];
  const add = (v) => (p.push(v), `$${p.length}`);
  const w = [`l.agency_id = $1`, `l.status = 'active'`];
  if (f.listing_type) w.push(`l.listing_type = ${add(f.listing_type)}`);
  if (isSet(f.property_types)) w.push(`l.property_type = ANY(${add(f.property_types)}::text[])`);
  if (isSet(f.places)) w.push("(" + f.places.map((x) => `l.${{ compound: "compound_key", developer: "developer_key", area: "area_key" }[x.kind]} = ${add(x.key)}`).join(" OR ") + ")");
  const price = "CASE WHEN coalesce(l.details->>'currency','EGP') = 'EGP' THEN l.price_value END";
  if (isSet(f.price_min)) w.push(`${price} >= ${add(f.price_min)}`);
  if (isSet(f.price_max)) w.push(`${price} <= ${add(f.price_max)}`);
  if (isSet(f.area_min)) w.push(`(l.area_value IS NULL OR l.area_value >= ${add(f.area_min)})`);
  if (isSet(f.area_max)) w.push(`(l.area_value IS NULL OR l.area_value <= ${add(f.area_max)})`);
  const bmin = f.bedrooms_min ?? null;
  const bmax = f.bedrooms_max ?? null;
  if (bmin !== null && bmin === bmax && bmin !== 0) w.push(`(l.bedrooms IS NULL OR l.bedrooms = ${add(bmin)})`);
  else if (bmin !== null && bmin !== bmax && bmin > 0) w.push(`(l.bedrooms IS NULL OR l.bedrooms >= ${add(bmin)})`);
  else if (bmin === 0 || bmax !== null) return [];
  const { rows } = await pool.query(`SELECT l.id FROM listings l WHERE ${Vis.units("l")} AND ${w.join(" AND ")} LIMIT 60`, p);
  const have = new Set(row.result_ids || []);
  return rows.map((r) => r.id).filter((id) => !have.has(id)).slice(0, 20);
}

/** Checks the searches of the last day that have not been checked. → counts for the summary. */
async function run(pool, { now = new Date(), limit = 2000 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM search_log WHERE audit IS NULL AND created_at > $1::timestamptz - interval '26 hours' AND created_at <= $1::timestamptz
      ORDER BY created_at LIMIT $2`,
    [now.toISOString(), limit]
  );
  const c = { searches: rows.length, zero: 0, wrong: 0, disagree: 0, missed: 0, core_missed: 0, ai_read: 0 };
  const examples = { wrong: [], zero: [], disagree: [], missed: [], core_missed: [] };
  for (const r of rows) {
    const audit = { checked_at: now.toISOString(), zero: false, bad_ids: [], missed_ids: [], disagree: [], core_missed_ids: [], drop_one: null };
    try {
      audit.zero = Number(r.total) === 0;
      if (r.result_ids?.length && r.used_filters) {
        const { rows: units } = await pool.query(`SELECT id, listing_type, bedrooms, area_value, price_value FROM listings WHERE ${Vis.units("listings")} AND id = ANY($1::uuid[])`, [r.result_ids]);
        audit.bad_ids = badUnits(r.used_filters, units);
      }
      audit.core_missed_ids = await coreMissed(pool, r);
      if (audit.zero && r.used_filters && !r.asked?.length) audit.drop_one = await dropOne(pool, r.agency_id, r.used_filters);
      if (r.ai_filters) {
        c.ai_read++;
        audit.disagree = disagreements(r.local_filters || r.used_filters, r.ai_filters);
        if (audit.disagree.length && Number(r.total) <= 50) {
          const found = await Search.runSearch(pool, r.agency_id, { filters: { ...r.ai_filters } }, { pageSize: 1 });
          const have = new Set(r.result_ids || []);
          audit.missed_ids = (found.ids || []).filter((id) => !have.has(id)).slice(0, 20);
        }
      }
    } catch (err) {
      audit.error = String(err.message).slice(0, 200);
    }
    await pool.query("UPDATE search_log SET audit = $2::jsonb WHERE id = $1", [r.id, JSON.stringify(audit)]);
    const note = (k) => examples[k].length < 3 && examples[k].push(r.query_text || "(form)");
    if (audit.zero) (c.zero++, note("zero"));
    if (audit.bad_ids.length) (c.wrong++, note("wrong"));
    if (audit.disagree.length) (c.disagree++, note("disagree"));
    if (audit.missed_ids.length) (c.missed++, note("missed"));
    if (audit.core_missed_ids.length) (c.core_missed++, note("core_missed"));
  }
  return { ...c, examples };
}

/** The short summary for the CRM owner. */
async function summary(pool, counts) {
  const { rows } = await pool.query(
    `SELECT (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms) FROM search_log WHERE created_at > now() - interval '26 hours' AND total_ms IS NOT NULL)::int AS p95,
            (SELECT COUNT(*) FROM search_log WHERE created_at > now() - interval '26 hours' AND total_ms > 5000)::int AS slow,
            (SELECT COUNT(*) FROM search_reports WHERE status = 'open')::int AS reports,
            (SELECT COUNT(*) FROM search_aliases WHERE status = 'pending')::int AS words`
  );
  const ex = (k, label) => (counts.examples[k].length ? `\n${label}: ${counts.examples[k].map((t) => `"${t}"`).join(", ")}` : "");
  return [
    `Search check: ${counts.searches} searches`,
    `Zero results ${counts.zero} · wrong results ${counts.wrong} · parser vs AI differ ${counts.disagree} · missed units ${counts.missed} · missed by the plain check ${counts.core_missed}`,
    `Speed: 95% of searches under ${rows[0].p95 === null ? "?" : (rows[0].p95 / 1000).toFixed(1)} s · slower than 5 s: ${rows[0].slow}`,
    `Open "Wrong search" reports ${rows[0].reports} · new words waiting ${rows[0].words}`,
    ex("wrong", "Wrong"),
    ex("zero", "Zero"),
    ex("core_missed", "Missed by the plain check"),
    ex("disagree", "Differ"),
    "Review: /app/owner/searches"
  ]
    .filter(Boolean)
    .join("\n");
}

const cairoDay = (now) => {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  const o = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour) % 24 };
};

/** Once a day after 03:00 Cairo: check, learn the safe words, tell the owner. */
const auditJob = () => ({
  name: "search_audit",
  everyMs: 30 * 60 * 1000,
  run: async ({ pool, now, watermark }) => {
    const day = cairoDay(new Date(now));
    if (watermark.audit === day.date || day.hour < 3) return { counts: {}, watermark };
    const counts = await run(pool, { now: new Date(now) });
    const approved = await require("./searchLearn").autoApprove(pool, new Date(now));
    if (counts.searches || approved) await Errors.alertOwner(`${await summary(pool, counts)}${approved ? `\nWords approved automatically: ${approved}` : ""}`);
    const { examples, ...numbers } = counts;
    return { counts: { ...numbers, auto_approved: approved }, watermark: { ...watermark, audit: day.date } };
  }
});

module.exports = { disagreements, badUnits, dropOne, coreMissed, run, summary, auditJob };
