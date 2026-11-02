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

/** Checks the searches of the last day that have not been checked. → counts for the summary. */
async function run(pool, { now = new Date(), limit = 2000 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM search_log WHERE audit IS NULL AND created_at > $1::timestamptz - interval '26 hours' AND created_at <= $1::timestamptz
      ORDER BY created_at LIMIT $2`,
    [now.toISOString(), limit]
  );
  const c = { searches: rows.length, zero: 0, wrong: 0, disagree: 0, missed: 0, ai_read: 0 };
  const examples = { wrong: [], zero: [], disagree: [], missed: [] };
  for (const r of rows) {
    const audit = { checked_at: now.toISOString(), zero: false, bad_ids: [], missed_ids: [], disagree: [] };
    try {
      audit.zero = Number(r.total) === 0;
      if (r.result_ids?.length && r.used_filters) {
        const { rows: units } = await pool.query(`SELECT id, listing_type, bedrooms, area_value, price_value FROM listings WHERE ${Vis.units("listings")} AND id = ANY($1::uuid[])`, [r.result_ids]);
        audit.bad_ids = badUnits(r.used_filters, units);
      }
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
  }
  return { ...c, examples };
}

/** The short summary for the CRM owner. */
async function summary(pool, counts) {
  const { rows } = await pool.query(
    `SELECT (SELECT COUNT(*) FROM search_reports WHERE status = 'open')::int AS reports,
            (SELECT COUNT(*) FROM search_aliases WHERE status = 'pending')::int AS words`
  );
  const ex = (k, label) => (counts.examples[k].length ? `\n${label}: ${counts.examples[k].map((t) => `"${t}"`).join(", ")}` : "");
  return [
    `Search check: ${counts.searches} searches`,
    `Zero results ${counts.zero} · wrong results ${counts.wrong} · parser vs AI differ ${counts.disagree} · missed units ${counts.missed}`,
    `Open "Wrong search" reports ${rows[0].reports} · new words waiting ${rows[0].words}`,
    ex("wrong", "Wrong"),
    ex("zero", "Zero"),
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

module.exports = { disagreements, badUnits, run, summary, auditJob };
