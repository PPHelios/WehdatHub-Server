// services/analyticsSearch.js — The nightly count of searches (analytics_search_daily). Each finished Cairo day is counted once,
// by place, type, sale/rent, bedroom band and budget band: never the query text, the broker, the agency or the result ids.
// "Counted through day D" is kept in analytics_meta in the same transaction as the counts, so a rerun adds nothing twice.
// lib/logRollup.js calls rollThrough() before it deletes search_log rows older than 90 days, so nothing is deleted uncounted.
"use strict";

const Bands = require("../domain/analyticsBands");

const MARKER = "search_rolled_through";
const CHUNK_DAYS = 7; // days read per transaction
const MAX_DAYS = 62; // days counted per run (a first run on a long history takes a few nights)
const MAX_ROWS = 100000; // searches read per run

const cairoStart = "($1::date)::timestamp AT TIME ZONE 'Africa/Cairo'";

/**
 * Counts every finished Cairo day not yet counted, up to `before` (a Date: days that end by it) or today.
 * @returns {{ days: number, searches: number, through: string|null }}
 */
async function rollThrough(pool, { now = new Date(), before = null } = {}) {
  let end = Bands.cairoDay(now); // today is not finished: days before it only
  if (before) {
    const b = Bands.cairoDay(before);
    if (b < end) end = b;
  }
  const out = { days: 0, searches: 0, through: null };
  // Places of a search: the area the search resolved to (area_scope), else an area key matched to areas.name_key (spaces or underscores).
  const areaRows = (await pool.query("SELECT name_key, id FROM areas")).rows;
  const areaIds = new Set(areaRows.map((r) => r.id));
  const areas = new Map();
  for (const r of areaRows) {
    areas.set(r.name_key, r.id);
    areas.set(r.name_key.replace(/s+/g, "_"), r.id);
  }
  while (out.days < MAX_DAYS && out.searches < MAX_ROWS) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO analytics_meta (key, value) VALUES ($1, '{}'::jsonb) ON CONFLICT (key) DO NOTHING", [MARKER]);
      const meta = (await client.query("SELECT value FROM analytics_meta WHERE key = $1 FOR UPDATE", [MARKER])).rows[0];
      let start = meta.value.day || null;
      if (!start) {
        const first = (await client.query("SELECT (min(created_at) AT TIME ZONE 'Africa/Cairo')::date::text AS d FROM search_log")).rows[0].d;
        if (!first) {
          await client.query("ROLLBACK");
          return out;
        }
        start = first;
      }
      if (start >= end) {
        await client.query("ROLLBACK");
        return out;
      }
      const to = Bands.addDays(start, CHUNK_DAYS) < end ? Bands.addDays(start, CHUNK_DAYS) : end;
      const { rows } = await client.query(
        `SELECT (created_at AT TIME ZONE 'Africa/Cairo')::date::text AS day, used_filters, total, reasons
           FROM search_log WHERE created_at >= ${cairoStart} AND created_at < (($2::date)::timestamp AT TIME ZONE 'Africa/Cairo')
          LIMIT ${MAX_ROWS + 1}`,
        [start, to]
      );
      if (rows.length > MAX_ROWS) throw new Error("analytics_search_row_budget");
      const cells = new Map();
      for (const r of rows) {
        if ((r.reasons || []).includes("admin_view")) continue; // the owner looking at another agency is not demand
        const c = Bands.searchCell(r.used_filters);
        const area = (c.area_id && areaIds.has(c.area_id) ? c.area_id : null) || (c.area_key ? areas.get(c.area_key) || null : null);
        const key = [r.day, area, c.property_type, c.listing_type, c.bedroom_band, c.budget_band].join("|");
        let cell = cells.get(key);
        if (!cell) cells.set(key, (cell = { day: r.day, area, c, searches: 0, zero: 0 }));
        cell.searches += 1;
        if (Number(r.total) === 0) cell.zero += 1;
      }
      const list = [...cells.values()];
      if (list.length) {
        await client.query(
          `INSERT INTO analytics_search_daily (day, area_id, property_type, listing_type, bedroom_band, budget_band, searches, zero_result)
           SELECT * FROM unnest($1::date[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::int[])
           ON CONFLICT (day, (COALESCE(area_id, '00000000-0000-0000-0000-000000000000'::uuid)), property_type, listing_type, bedroom_band, budget_band)
           DO UPDATE SET searches = analytics_search_daily.searches + EXCLUDED.searches, zero_result = analytics_search_daily.zero_result + EXCLUDED.zero_result`,
          [list.map((x) => x.day), list.map((x) => x.area), list.map((x) => x.c.property_type), list.map((x) => x.c.listing_type), list.map((x) => x.c.bedroom_band), list.map((x) => x.c.budget_band), list.map((x) => x.searches), list.map((x) => x.zero)]
        );
      }
      await client.query("UPDATE analytics_meta SET value = $2::jsonb, updated_at = now() WHERE key = $1", [MARKER, JSON.stringify({ day: to })]);
      await client.query("COMMIT");
      out.days += Math.round((Date.parse(to) - Date.parse(start)) / 86400000);
      out.searches += rows.length;
      out.through = to;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  return out;
}

module.exports = { rollThrough, MARKER };
