// services/projectRows.js — A project's details as rows and columns (migration 117), so every one is searchable: its place (the same
// graph as units), features, size, price from, down payment, term, discount, bedrooms and types; one row per unit offer
// (project_offers, source 'paste') and per other fact (project_facts) read from the pasted launch message; and search_text,
// everything above as one normalized string. services/catalogue.js saveProject calls apply(); the list page calls filters().
"use strict";

const Paste = require("../domain/projectPaste");
const Graph = require("../domain/placeGraph");
const A = require("../domain/areas");
const Features = require("../domain/features");
const Rules = require("../domain/fieldRules");
const Describe = require("../domain/describe");
const { keysOf, placeKey } = require("../domain/mapPlaces");
const { normalizeSearch } = require("../domain/searchText");
const Suggest = require("./placeSuggest");

const MAX_OFFERS = 60;
const MAX_FACTS = 12;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v) => UUID_RE.test(String(v || ""));
const list = (v) => [].concat(v ?? []).flatMap((x) => (typeof x === "string" ? x.split(/[,،]/) : [x])).map((x) => String(x).trim()).filter(Boolean);
const bad = (field) => ({ error: "invalid", field });

/** A decimal typed in a form (Arabic digits, commas); null when empty, NaN when not a number. */
function number(v, max) {
  const { normalizeDigits } = require("../lib/text");
  const s = normalizeDigits(String(v ?? "")).replace(/[,،٬\s]/g, "").replace(/٫/g, ".").replace(/%$/, "");
  if (s === "") return null;
  if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
  const n = Number(s);
  return n > max ? NaN : n;
}

/** The validated columns from a form or a read: { fields } | { error }. */
function columns(input) {
  const f = {};
  for (const [k, max] of [["area_acres", 100000], ["price_from", 5e9], ["down_pct_min", 100], ["years_max", 20], ["discount_pct", 100]]) {
    if (input[k] === undefined) continue;
    const n = number(input[k], max);
    if (Number.isNaN(n)) return bad(k);
    f[k] = n;
  }
  if (input.bedrooms !== undefined) {
    const b = list(input.bedrooms).map(Number);
    if (b.some((n) => !Number.isInteger(n) || n < 1 || n > 9)) return bad("bedrooms");
    f.bedroom_options = [...new Set(b)].sort((x, y) => x - y);
  }
  if (input.property_types !== undefined) {
    const t = list(input.property_types);
    if (t.some((x) => !Rules.PROPERTY_TYPES.includes(x))) return bad("property_types");
    f.property_types = [...new Set(t)];
  }
  if (input.feature !== undefined) f.feature_keys = Features.sortKeys(list(input.feature));
  if (input.features_other !== undefined) f.features_other = list(input.features_other).map((s) => s.slice(0, 60)).slice(0, 20);
  if (input.delivery_raw !== undefined) f.delivery_raw = String(input.delivery_raw || "").replace(/\s+/g, " ").trim().slice(0, 80) || null;
  if (input.paste_text !== undefined) f.source_text = String(input.paste_text || "").trim().slice(0, 8000) || null;
  return { fields: f };
}

/**
 * The place the box chose: a compound by name (an approved place), else the area and sub-zone ids.
 * { place_id, area_id, subzone_id, district, city, place_ids } — empty when nothing is chosen.
 */
async function placeOf(pool, { compound, area_id, subzone_id } = {}) {
  const l = await Suggest.lists(pool);
  const typed = String(compound || "").trim();
  let place = null;
  if (typed) {
    const k = placeKey(typed);
    place = l.places.find((p) => keysOf(p).includes(k)) || null;
  }
  const area = place?.area_id || (isId(area_id) ? area_id : null);
  const sub = place ? place.subzone_id || null : isId(subzone_id) ? subzone_id : null;
  const pick = { place_id: place?.id || null, area_id: area, subzone_id: sub };
  const chain = A.chain(l.areas, sub || area);
  const nm = (a) => a.name_en || a.name_ar;
  return {
    ...pick,
    district: chain.length ? nm(chain[chain.length - 1]) : null,
    city: chain.length ? nm(chain[0]) : null,
    governorate: chain.length ? chain[0].governorate || null : null,
    place_ids: Graph.placeIds(pick, { areas: l.areas, zones: l.zones })
  };
}

/** Everything about the project as one normalized string: names, developer, place and its parents, features, types, facts. */
async function searchText(pool, projectId) {
  const { rows } = await pool.query("SELECT * FROM projects WHERE id = $1", [projectId]);
  const p = rows[0];
  if (!p) return "";
  const l = await Suggest.lists(pool);
  const placeNames = [];
  for (const id of p.place_ids || []) {
    const row = l.places.find((x) => x.id === id) || l.areas.find((x) => x.id === id);
    if (row) placeNames.push(row.name_en, row.name_ar, ...(row.aliases || []));
  }
  const { rows: facts } = await pool.query("SELECT label_ar, label_en, value FROM project_facts WHERE project_id = $1", [projectId]);
  const { rows: dev } = p.developer_id ? await pool.query("SELECT name, name_en FROM developers WHERE id = $1", [p.developer_id]) : { rows: [] };
  const types = (p.property_types || []).flatMap((t) => (Describe.TYPE_LABELS[t] ? Describe.TYPE_LABELS[t] : [t]));
  const parts = [
    p.name, p.name_en, p.developer_name, dev[0]?.name, dev[0]?.name_en, p.district, p.city, p.governorate, ...placeNames,
    ...(p.feature_keys || []).flatMap((k) => [Features.featureLabel(k, "ar"), Features.featureLabel(k, "en")]), ...(p.features_other || []),
    ...types, p.delivery_raw, p.status, ...facts.flatMap((f) => [f.label_ar, f.label_en, f.value]),
    p.bedroom_options?.length ? p.bedroom_options.map((b) => `${b} bedrooms ${b} غرف`).join(" ") : null,
    p.area_acres ? `${Number(p.area_acres)} فدان feddan acres` : null
  ];
  return normalizeSearch(parts.filter(Boolean).join(" ")).slice(0, 4000);
}

async function replaceRows(pool, actor, projectId, text) {
  const read = Paste.read(text);
  await pool.query("DELETE FROM project_offers WHERE project_id = $1 AND agency_id = $2 AND source = 'paste'", [projectId, actor.agency_id]);
  for (const o of read.offers.slice(0, MAX_OFFERS)) {
    await pool.query(
      `INSERT INTO project_offers (agency_id, project_id, area, floor, bedrooms, price, down, monthly, monthly_est, years, raw, source, property_type, discount_pct)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'paste', $12, $13)`,
      [actor.agency_id, projectId, o.area, o.floor, o.bedrooms, o.price, o.down, o.monthly, o.monthly_est, o.years, String(o.raw || "").slice(0, 300), o.property_type, o.discount_pct]
    );
  }
  await pool.query("DELETE FROM project_facts WHERE project_id = $1 AND source = 'paste'", [projectId]);
  for (const f of read.facts.slice(0, MAX_FACTS)) {
    await pool.query("INSERT INTO project_facts (agency_id, project_id, key, label_ar, label_en, value, source) VALUES ($1, $2, $3, $4, $5, $6, 'paste')", [actor.agency_id, projectId, f.key, f.label_ar, f.label_en, f.value]);
  }
  return read;
}

/**
 * Saves the rows part of a project form (only the fields the form sent). Called by saveProject after the project row exists.
 * @returns {{ ok: true } | { error: "invalid", field }}
 */
async function apply(pool, actor, projectId, input = {}) {
  const c = columns(input);
  if (c.error) return c;
  const sets = { ...c.fields };
  if (input.area_id !== undefined || input.compound !== undefined) {
    const pl = await placeOf(pool, input);
    Object.assign(sets, { place_id: pl.place_id, area_id: pl.area_id, subzone_id: pl.subzone_id, place_ids: pl.place_ids, governorate: pl.governorate, pending_area_id: null });
    // Ask and the old pages read district and city as text: they follow the place (a typed value is kept when no place is chosen).
    if (pl.area_id) Object.assign(sets, { district: pl.district, city: pl.city });
  }
  // A sub-area the list does not have: it is requested (pending, never shown to other agencies' lists) and the project is filed under the
  // parent picked, so it is found by place at once. When the CRM owner approves it, promotePending() moves the project under it.
  const newName = String(input.compound || "").trim();
  if (input.compound_new === "1" && newName && sets.area_id) {
    const arabic = /[؀-ۿ]/.test(newName);
    const ar = String(input.compound_ar || "").trim();
    const asked = await require("./placeReview").proposeArea(pool, actor.id, {
      parent_id: sets.subzone_id || sets.area_id,
      name_en: arabic ? undefined : newName,
      name_ar: arabic ? newName : /[؀-ۿ]/.test(ar) ? ar : undefined
    }).catch(() => ({ status: "invalid" }));
    if (asked.status === "pending") sets.pending_area_id = asked.id;
    if (asked.status === "approved" && asked.id) {
      const l = await Suggest.lists(pool);
      const at = A.placement(l.areas, asked.id);
      const pl2 = await placeOf(pool, { area_id: at.area_id, subzone_id: at.subzone_id });
      Object.assign(sets, { area_id: pl2.area_id, subzone_id: pl2.subzone_id, place_ids: pl2.place_ids, district: pl2.district, governorate: pl2.governorate });
    }
  }

  const keys = Object.keys(sets);
  if (keys.length) {
    await pool.query(`UPDATE projects SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(", ")}, updated_at = now() WHERE id = $1 AND agency_id = $2`, [projectId, actor.agency_id, ...keys.map((k) => sets[k])]);
  }
  if (input.paste_text !== undefined) await replaceRows(pool, actor, projectId, sets.source_text || "");
  await pool.query("UPDATE projects SET search_text = $3 WHERE id = $1 AND agency_id = $2", [projectId, actor.agency_id, await searchText(pool, projectId)]);
  return { ok: true };
}

/** Rebuilds search_text (and the place from district/city when none is set) for every project of an agency, or of all agencies. */
async function rebuild(pool, agencyId = null) {
  const { rows } = await pool.query("SELECT id, agency_id, district, city, place_ids FROM projects WHERE ($1::uuid IS NULL OR agency_id = $1)", [agencyId]);
  const l = await Suggest.lists(pool);
  const index = A.buildIndex(l.areas);
  for (const p of rows) {
    if (!p.place_ids?.length) {
      const hit = [p.district, p.city].filter(Boolean).map((t) => A.resolveArea(index, t)).find((h) => h?.id);
      if (hit) {
        const at = A.placement(l.areas, hit.id);
        const ids = Graph.placeIds({ area_id: at.area_id, subzone_id: at.subzone_id }, { areas: l.areas, zones: [] });
        await pool.query("UPDATE projects SET area_id = $2, subzone_id = $3, place_ids = $4 WHERE id = $1", [p.id, at.area_id, at.subzone_id, ids]);
      }
    }
    await pool.query("UPDATE projects SET search_text = $2 WHERE id = $1", [p.id, await searchText(pool, p.id)]);
  }
  return rows.length;
}

/** Projects that asked for a new sub-area move under it once the CRM owner has approved it (called after a place review). */
async function promotePending(pool) {
  const Suggest2 = require("./placeSuggest");
  Suggest2.resetCache();
  const { rows } = await pool.query("SELECT p.id FROM projects p JOIN areas a ON a.id = p.pending_area_id WHERE a.status = 'approved'");
  if (!rows.length) return 0;
  const l = await Suggest.lists(pool);
  for (const { id } of rows) {
    const { rows: pr } = await pool.query("SELECT pending_area_id FROM projects WHERE id = $1", [id]);
    const at = A.placement(l.areas, pr[0].pending_area_id);
    const pl = await placeOf(pool, { area_id: at.area_id, subzone_id: at.subzone_id });
    await pool.query("UPDATE projects SET area_id = $2, subzone_id = $3, place_ids = $4, district = $5, governorate = $6, pending_area_id = NULL WHERE id = $1", [id, pl.area_id, pl.subzone_id, pl.place_ids, pl.district, pl.governorate]);
    await pool.query("UPDATE projects SET search_text = $2 WHERE id = $1", [id, await searchText(pool, id)]);
  }
  return rows.length;
}

/**
 * The catalogue search as SQL conditions on projects `p`: { where, params } to append after the agency condition.
 * q: words (all must be found in search_text or the name); place: one place id; features: all of them; developer: id;
 * bedrooms: one count; maxPrice: price from at most this.
 */
function filters({ q = "", place = null, features = [], developer = null, bedrooms = null, maxPrice = null } = {}, startAt) {
  const where = [];
  const params = [];
  const at = () => `$${startAt - 1 + params.length}`;
  const words = normalizeSearch(q).split(/\s+/).filter((w) => w.length >= 2).slice(0, 6);
  for (const w of words) {
    params.push(`%${w.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    where.push(`(p.search_text ILIKE ${at()} OR p.name ILIKE ${at()} OR p.name_en ILIKE ${at()})`);
  }
  if (isId(place)) { params.push(place); where.push(`${at()}::uuid = ANY(p.place_ids)`); }
  const keys = Features.sortKeys(list(features));
  if (keys.length) { params.push(keys); where.push(`p.feature_keys @> ${at()}::text[]`); }
  if (isId(developer)) { params.push(developer); where.push(`p.developer_id = ${at()}`); }
  const b = Number(bedrooms);
  if (Number.isInteger(b) && b >= 1 && b <= 9) { params.push(b); where.push(`${at()}::smallint = ANY(p.bedroom_options)`); }
  const mp = number(maxPrice, 5e9);
  if (mp) { params.push(mp); where.push(`p.price_from <= ${at()}`); }
  return { where, params };
}

module.exports = { apply, rebuild, promotePending, filters, searchText, placeOf, columns, replaceRows, number };
