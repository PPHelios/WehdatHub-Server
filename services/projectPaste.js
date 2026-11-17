// services/projectPaste.js — A pasted launch message → what the project form shows (free, no AI, nothing is saved): the project's name,
// its developer (one already in the agency's list, or a new name), its place and features (the unit box's reader), the numbers
// (domain/projectPaste.js) and the project already in the catalogue that the message names. The form shows every answer for
// the broker to check; the save reads the message again (services/projectRows.js), so a posted answer is never trusted.
"use strict";

const Paste = require("../domain/projectPaste");
const ParserLog = require("./parserLog");
const Names = require("../domain/projectNames");
const { normalizeSearch } = require("../domain/searchText");
const Suggest = require("./placeSuggest");

const SHORT = 5; // a message of this many words or fewer, with no digit, is a name and nothing else

const isLatin = (s) => /^[\x20-\x7e]+$/.test(s);

/** The agency's developer named in the text (whole words, either name), longest name first; null when none. */
function knownDeveloper(text, developers) {
  const hay = ` ${normalizeSearch(text)} `;
  return (
    developers
      .flatMap((d) => [d.name, d.name_en].filter(Boolean).map((n) => ({ d, key: normalizeSearch(n) })))
      .filter((x) => x.key.length >= 3 && hay.includes(` ${x.key} `))
      .sort((a, b) => b.key.length - a.key.length)[0]?.d || null
  );
}

/**
 * @returns {Promise<{ name, name_en, name_candidates, developer, place, features, existing, fields, offers, facts, found }>}
 * developer: { id, name } (in the list) | { name, new: true } | null. existing: { id, name } | null. `found`: the names of what was read.
 */
async function read(pool, actor, text, lang = "ar") {
  const src = String(text || "").trim().slice(0, 8000);
  const t0 = Date.now();
  const parsed = Paste.read(src);
  ParserLog.logParserRead(pool, { agency_id: actor.agency_id, broker_id: actor.id, parser: "project_paste", kind: "text", text: src, result: { ms: Date.now() - t0, read: Object.keys(parsed).filter((k) => parsed[k] !== null && !(Array.isArray(parsed[k]) && !parsed[k].length) && typeof parsed[k] !== "object"), missing: ["price_from", "delivery_year", "area_acres"].filter((k) => parsed[k] == null) } });
  const [{ rows: developers }, { rows: projects }, box] = await Promise.all([
    pool.query("SELECT id, name, name_en FROM developers WHERE agency_id = $1", [actor.agency_id]),
    pool.query("SELECT id, name, name_en FROM projects WHERE agency_id = $1", [actor.agency_id]),
    Suggest.boxResolve(pool, src, lang)
  ]);

  const { rows: globals } = await pool.query("SELECT id, name, name_en FROM global_developers");
  let dev = knownDeveloper(src, developers);
  if (!dev) {
    const g = knownDeveloper(src, globals);
    if (g) dev = { global_id: g.id, name: g.name, new: true };
  }
  // A project already in the catalogue is named by the message only when a name in it is the same name (one shared word is not enough:
  // "Skyline Obour" and "Obour Heights" are two projects).
  const existing = projects.find((p) => parsed.name_candidates.some((n) => Names.sameName(n, p.name) || Names.sameName(n, p.name_en))) || null;
  let candidates = parsed.name_candidates;

  // A message that is only a name (no digits, a few words): a developer when the list has it, else a project name to check.
  const words = src.split(/\s+/).filter(Boolean);
  if (words.length && words.length <= SHORT && !/\d/.test(src)) {
    if (!dev) {
      const asProject = Names.fuzzyMatch(src, projects)[0];
      if (!asProject) candidates = [src.replace(/\s+/g, " ")];
    }
  }

  // A project is filed under an area, not a compound: a compound the message names becomes its sub-area (or area).
  let place = box.place;
  if (place && place.kind === "compound") {
    const l = await Suggest.lists(pool);
    const row = l.areas.find((a) => a.id === (place.subzone_id || place.area_id));
    const nm = row && (lang === "en" ? row.name_en || row.name_ar : row.name_ar || row.name_en);
    place = (row && require("../domain/areas").suggest(nm, { places: [], areas: l.areas }, 20, lang).find((s) => s.id === row.id)) || null;
  }
  const name = existing ? existing.name : candidates[0] || null;
  if (!dev && parsed.developer_candidates[0]) dev = { name: parsed.developer_candidates[0], new: true };
  const fields = {
    area_acres: parsed.area_acres,
    delivery_raw: parsed.delivery_raw,
    delivery_year: parsed.delivery_year,
    status: parsed.status,
    price_from: parsed.price_from,
    down_pct_min: parsed.down_pct_min,
    years_max: parsed.years_max,
    discount_pct: parsed.discount_pct,
    bedrooms: parsed.bedrooms,
    property_types: parsed.property_types
  };
  const found = [
    name && "name", dev && "developer", place && "place", box.features.length && "features",
    ...Object.entries(fields).filter(([, v]) => (Array.isArray(v) ? v.length : v != null)).map(([k]) => k),
    parsed.offers.length && "offers", parsed.facts.length && "facts"
  ].filter(Boolean);
  return {
    name,
    name_en: name && isLatin(name) ? name : null,
    name_candidates: candidates,
    developer: dev ? (dev.id ? { id: dev.id, name: dev.name } : dev) : null,
    place,
    features: box.features,
    existing: existing ? { id: existing.id, name: existing.name } : null,
    fields,
    offers: parsed.offers.map(({ raw, ...o }) => o),
    facts: parsed.facts,
    found
  };
}

/**
 * What the form posts for a message read and accepted as it is: the input of Catalogue.saveProject. The seed and the tests use it.
 * @param {string} text the pasted message
 * @param {Awaited<ReturnType<typeof read>>} r its read
 */
function formInput(text, r) {
  const f = r.fields;
  return {
    name: r.name,
    name_en: r.name_en || "",
    developer_name: r.developer ? r.developer.name : "",
    developer_global_id: r.developer && r.developer.global_id ? r.developer.global_id : "",
    paste_text: text,
    area_id: r.place ? r.place.area_id || "" : "",
    subzone_id: r.place ? r.place.subzone_id || "" : "",
    compound: "",
    feature: r.features.map((x) => x.key),
    status: f.status || "selling",
    price_from: f.price_from ?? "",
    area_acres: f.area_acres ?? "",
    down_pct_min: f.down_pct_min ?? "",
    years_max: f.years_max ?? "",
    discount_pct: f.discount_pct ?? "",
    delivery_raw: f.delivery_raw || "",
    delivery_year: f.delivery_year ?? "",
    bedrooms: f.bedrooms,
    property_types: f.property_types
  };
}

/** The search box's answer: places and features (the unit box's list) then developers and projects of the agency, for what is typed. */
async function searchBox(pool, actor, q, lang = "ar") {
  const text = String(q || "").trim().slice(0, 80);
  if (text.length < 2) return [];
  const pattern = `%${text.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const [base, { rows: devs }, { rows: projs }] = await Promise.all([
    Suggest.box(pool, text, lang),
    pool.query("SELECT id, name, name_en FROM developers WHERE agency_id = $1 AND (name ILIKE $2 OR name_en ILIKE $2) ORDER BY lower(name) LIMIT 5", [actor.agency_id, pattern]),
    pool.query("SELECT id, name, name_en FROM projects WHERE agency_id = $1 AND archived_at IS NULL AND (name ILIKE $2 OR name_en ILIKE $2) ORDER BY lower(name) LIMIT 5", [actor.agency_id, pattern])
  ]);
  const nm = (r) => (lang === "en" ? r.name_en || r.name : r.name || r.name_en);
  return [
    ...base,
    ...devs.map((d) => ({ kind: "developer", id: d.id, label: nm(d) })),
    ...projs.map((p) => ({ kind: "project", id: p.id, label: nm(p) }))
  ];
}

/** Developers of the agency matching what is typed (the form's picker): [{ id, name, name_en }]. */
async function developerBox(pool, actor, q) {
  const text = String(q || "").trim().slice(0, 80);
  const pattern = text ? `%${text.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
  const { rows } = await pool.query(
    "SELECT id, name, name_en FROM developers WHERE agency_id = $1 AND ($2::text IS NULL OR name ILIKE $2 OR name_en ILIKE $2) ORDER BY lower(name) LIMIT 8",
    [actor.agency_id, pattern]
  );
  // Then the global directory (names only), except the ones the agency already has.
  const { rows: globals } = await pool.query(
    `SELECT g.id AS global_id, g.name, g.name_en FROM global_developers g
     WHERE ($2::text IS NULL OR g.name ILIKE $2 OR g.name_en ILIKE $2)
       AND NOT EXISTS (SELECT 1 FROM developers d WHERE d.agency_id = $1 AND (d.global_id = g.id OR lower(btrim(d.name)) = lower(btrim(g.name))))
     ORDER BY lower(g.name) LIMIT 8`,
    [actor.agency_id, pattern]
  );
  return [...rows, ...globals];
}

module.exports = { read, formInput, searchBox, developerBox };
