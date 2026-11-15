// services/projectSearch.js — The one grouped project search, used by Ask (web and app) and the catalogue: every project once, with the offers (units)
// that fit, or its free text when it has no unit details. It reads the project rows (migrations 117-119: place_ids, feature_keys, bedroom_options,
// price_from, down_pct_min, project_offers) and keeps the offer rules of domain/projectNotes.js. Pure reading: nothing is saved or guessed.
// search(pool, agencyId, filters, { sort, page, perPage, q }) → { total_projects, total_options, page, pages, per_page, sort, projects: [...] }
"use strict";

const ProjectNotes = require("../domain/projectNotes");
const A = require("../domain/areas");
const Features = require("../domain/features");
const Describe = require("../domain/describe");
const { normalizeSearch } = require("../domain/searchText");
const { normalizeDigits } = require("../lib/text");
const Offers = require("./projectOffers");
const Suggest = require("./placeSuggest");

const SORTS = ["best", "cheap", "pricey", "small", "big", "down"];
const MAX_OFFERS_SHOWN = 5;
const MAX_PER_PAGE = 25;
const OFFER_KEYS = ["area_min", "area_max", "price_min", "price_max", "max_installment", "max_down_payment", "bedrooms_min", "bedrooms_max"];
// The explicit filter row of the page (short names) → the filters of domain/searchQuery.
const EXPLICIT = { pmin: "price_min", pmax: "price_max", amin: "area_min", amax: "area_max", dmax: "max_down_payment", imax: "max_installment" };
const n = (v) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const num = (v) => {
  const x = n(normalizeDigits(String(v ?? "")).replace(/[,،٬\s]/g, ""));
  return x != null && x >= 0 ? x : null;
};

/** The question's filters with the page's explicit ones over them: pmin pmax amin amax dmax imax bed. */
function mergeExplicit(f = {}, explicit = {}) {
  const out = { ...f };
  for (const [short, key] of Object.entries(EXPLICIT)) {
    const v = num(explicit[short]);
    if (v != null) out[key] = v;
  }
  const bed = Number(explicit.bed);
  if (Number.isInteger(bed) && bed >= 1 && bed <= 9) Object.assign(out, { bedrooms_min: bed, bedrooms_max: bed });
  return out;
}

/**
 * A typed place as a person writes it: "el obour", "al obour", "the obour" also mean "obour"; and when the reader glued a stray word on ("obour price"), the
 * words of the term are tried one by one. The term itself stays first.
 */
function placeVariants(terms) {
  const out = new Set();
  for (const t of terms) {
    out.add(t);
    const bare = t.replace(/^(el|al|the) /, "").replace(/^ال/, "");
    if (bare && bare !== t) out.add(bare);
    const words = bare.split(" ").filter((w) => w.length >= 4);
    if (words.length > 1) for (const w of words) out.add(w);
  }
  return [...out];
}

/** The area ids the place words name (an area, a sub-area, or both), by the same names and aliases the boxes use; [] when none is known. */
function placeIdsOf(terms, areas) {
  const ids = new Set();
  for (const t of terms) {
    const hit = A.suggest(t, { places: [], areas }, 3, "en").find((s) => s.via !== "alike");
    if (hit) ids.add(hit.id);
  }
  return ids;
}

const typeLabel = (t, lang) => (Describe.TYPE_LABELS[t] ? Describe.TYPE_LABELS[t][lang === "en" ? 1 : 0] : t || null);

/** The lines of a project's notes that fit the request (its numbers), else the first lines: the free text of a project with no unit details. */
function freeText(notes, numbers) {
  const lines = String(notes || "").split(/\n|__|🔥/).map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s.length > 3);
  if (!lines.length) return null;
  const hit = numbers.length ? lines.filter((s) => numbers.some((x) => new RegExp(`(^|[^\\d.])${x.replace(".", "\\.")}([^\\d]|$)`).test(normalizeDigits(s)))) : [];
  return (hit.length ? hit : lines).slice(0, 3).join("\n");
}

const requestNumbers = (text) => [...new Set((normalizeDigits(String(text || "")).match(/\d+(?:\.\d+)?/g) || []).map((x) => String(Number(x))))];

/** A project's lowest down payment in EGP from its own numbers (price from × lowest down payment %), or null when it does not say both. */
function projectDown(p) {
  return p.price_from != null && p.down_pct_min != null ? Math.round((Number(p.price_from) * Number(p.down_pct_min)) / 100) : null;
}

function sortKeys(g) {
  const prices = g.offers.map((o) => o.price).filter((x) => x != null);
  const areas = g.offers.map((o) => o.area).filter((x) => x != null);
  const downs = g.offers.map((o) => o.down).filter((x) => x != null);
  return {
    price: prices.length ? Math.min(...prices) : g.project.price_from != null ? Number(g.project.price_from) : Infinity,
    priceMax: prices.length ? Math.max(...prices) : g.project.price_from != null ? Number(g.project.price_from) : -Infinity,
    area: areas.length ? Math.min(...areas) : Infinity,
    areaMax: areas.length ? Math.max(...areas) : -Infinity,
    down: downs.length ? Math.min(...downs) : projectDown(g.project) ?? Infinity
  };
}

/**
 * @param {object} filters domain/searchQuery filters (place_terms, locations, places, features, area_*, price_*, max_down_payment, max_installment, bedrooms_*)
 * @param {{ sort?: string, page?: number, perPage?: number, q?: string, explicit?: object, lang?: string, developer?: string }} opts
 */
async function search(pool, agencyId, filters = {}, { sort = "best", page = 1, perPage = 10, q = "", explicit = {}, lang = "ar", developer = null, unitsOnly = false } = {}) {
  const f = mergeExplicit(filters, explicit);
  const order = SORTS.includes(sort) ? sort : "best";
  const per = Math.min(MAX_PER_PAGE, Math.max(1, Number(perPage) || 10));
  const places = placeVariants([...(f.locations || []), ...(f.places || []).map((p) => p.key), ...(f.place_terms || [])].map((p) => normalizeSearch(p)).filter(Boolean));
  const featureKeys = Features.sortKeys(f.features || []);
  const offerLevel = OFFER_KEYS.some((k) => f[k] != null);
  const asked = places.length || featureKeys.length || offerLevel || developer;
  const empty = { total_projects: 0, total_options: 0, page: 1, pages: 1, per_page: per, sort: order, projects: [] };
  if (!asked || f.listing_type === "rent") return empty;

  await Offers.sync(pool, agencyId);
  const [{ rows: projects }, { rows: offerRows }, lists] = await Promise.all([
    pool.query(
      `SELECT p.id, p.name, p.name_en, p.status, p.district, p.city, p.governorate, p.delivery_year, p.delivery_quarter, p.delivery_raw, p.notes, p.updated_at,
              p.price_from, p.area_acres, p.down_pct_min, p.years_max, p.discount_pct, p.bedroom_options, p.property_types, p.feature_keys, p.place_ids, p.developer_id,
              COALESCE(d.name, p.developer_name) AS developer_name,
              (SELECT url FROM project_images i WHERE i.project_id = p.id AND i.role = 'shared' ORDER BY i.position, i.created_at LIMIT 1) AS cover_url
         FROM projects p LEFT JOIN developers d ON d.id = p.developer_id WHERE p.agency_id = $1 AND p.archived_at IS NULL`,
      [agencyId]
    ),
    pool.query("SELECT * FROM project_offers WHERE agency_id = $1 ORDER BY price, id", [agencyId]),
    Suggest.lists(pool)
  ]);
  const byProject = new Map();
  for (const o of offerRows) {
    if (!byProject.has(o.project_id)) byProject.set(o.project_id, []);
    byProject.get(o.project_id).push({
      type: o.property_type || null, area: n(o.area), floor: o.floor, bedrooms: n(o.bedrooms), price: n(o.price), down: n(o.down),
      monthly: n(o.monthly), monthly_est: n(o.monthly_est), years: n(o.years), discount_pct: n(o.discount_pct)
    });
  }
  const placeIds = placeIdsOf(places, lists.areas);
  const numbers = requestNumbers(q);
  const groups = [];
  for (const p of projects) {
    if (developer && p.developer_id !== developer) continue;
    if (places.length && !((p.place_ids || []).some((id) => placeIds.has(id)) || ProjectNotes.matchesPlace(p, places))) continue;
    if (featureKeys.length && !featureKeys.every((k) => (p.feature_keys || []).includes(k))) continue;
    const all = byProject.get(p.id) || [];
    const fitting = all.filter((u) => ProjectNotes.unitFits(u, f));
    if (all.length) {
      // A project with unit details shows only if a unit fits what was asked about units; with none asked it shows its units.
      if (offerLevel && !fitting.length) continue;
    } else if (offerLevel) {
      // No unit details: the project's own numbers answer what they can (price from, bedrooms); it is shown with its free text.
      if (f.price_max != null && !(p.price_from != null && Number(p.price_from) <= f.price_max)) continue;
      if (f.price_min != null && p.price_from != null && Number(p.price_from) < f.price_min) continue;
      const beds = (p.bedroom_options || []).map(Number);
      if (f.bedrooms_min != null && !beds.some((b) => b >= f.bedrooms_min && (f.bedrooms_max == null || b <= f.bedrooms_max))) continue;
      if (f.area_min != null || f.area_max != null || f.max_installment != null) continue; // the project does not say
      if (f.max_down_payment != null && !(projectDown(p) != null && projectDown(p) <= f.max_down_payment)) continue;
    }
    if (unitsOnly && !fitting.length) continue;
    // Why it is listed: everything that was asked and that it satisfied (a project that fails any asked check is not here at all).
    const matched = [
      places.length && "place", featureKeys.length && "features", developer && "developer",
      (f.price_min != null || f.price_max != null) && "price", (f.area_min != null || f.area_max != null) && "area",
      (f.bedrooms_min != null || f.bedrooms_max != null) && "bedrooms", f.max_down_payment != null && "down", f.max_installment != null && "installment"
    ].filter(Boolean);
    groups.push({ project: p, offers: fitting.sort((a, b) => a.price - b.price), offers_total: fitting.length, matched });
  }

  const keyOf = new Map(groups.map((g) => [g, sortKeys(g)]));
  const cmp = {
    cheap: (a, b) => keyOf.get(a).price - keyOf.get(b).price,
    pricey: (a, b) => keyOf.get(b).priceMax - keyOf.get(a).priceMax,
    small: (a, b) => keyOf.get(a).area - keyOf.get(b).area,
    big: (a, b) => keyOf.get(b).areaMax - keyOf.get(a).areaMax,
    down: (a, b) => keyOf.get(a).down - keyOf.get(b).down,
    best: (a, b) => b.offers_total - a.offers_total || keyOf.get(a).price - keyOf.get(b).price
  }[order];
  groups.sort((a, b) => cmp(a, b) || String(a.project.name).localeCompare(String(b.project.name)));

  const pages = Math.max(1, Math.ceil(groups.length / per));
  const at = Math.min(Math.max(1, Number(page) || 1), pages);
  const shown = groups.slice((at - 1) * per, at * per).map((g) => card(g, { lang, numbers }));
  return { total_projects: groups.length, total_options: groups.reduce((s, g) => s + g.offers_total, 0), page: at, pages, per_page: per, sort: order, projects: shown };
}

/** One project's result: its facts, the offers that fit (at most 5, the count of all), and its free text when it has no unit details. */
function card(g, { lang, numbers }) {
  const p = g.project;
  const en = lang === "en";
  const L = (ar, e) => (en ? e : ar);
  const delivery = p.delivery_year ? `${p.delivery_quarter ? `Q${p.delivery_quarter} ` : ""}${p.delivery_year}` : p.delivery_raw || null;
  const facts = [
    p.area_acres != null && [L("المساحة", "Size"), `${Number(p.area_acres)} ${L("فدان", "feddan")}`],
    (p.bedroom_options || []).length && [L("الغرف", "Bedrooms"), p.bedroom_options.join(" · ")],
    p.down_pct_min != null && [L("أقل مقدم", "Lowest down payment"), `${Number(p.down_pct_min)}%`],
    p.years_max != null && [L("أطول تقسيط", "Longest term"), `${Number(p.years_max)} ${L("سنين", "years")}`],
    p.discount_pct != null && [L("خصم", "Discount"), `${Number(p.discount_pct)}%`],
    (p.property_types || []).length && [L("النوع", "Types"), p.property_types.map((t) => typeLabel(t, lang)).join(" · ")]
  ].filter(Boolean).map(([label, value]) => ({ label, value }));
  const offers = g.offers.slice(0, MAX_OFFERS_SHOWN).map((u) => ({
    type: typeLabel(u.type, lang), area: u.area, floor: u.floor, bedrooms: u.bedrooms, price: u.price, down: u.down, monthly: u.monthly ?? u.monthly_est, years: u.years, discount_pct: u.discount_pct
  }));
  const free = g.offers_total ? null : freeText(p.notes, numbers);
  const Answer = require("./projectAnswer");
  const clientText = g.offers_total
    ? Answer.clientText(g.offers.slice(0, MAX_OFFERS_SHOWN).map((unit) => ({ project: p, unit })), lang)
    : [p.name_en || p.name, p.price_from != null ? `${L("يبدأ من", "from")} ${Number(p.price_from).toLocaleString("en-US")} ${L("جنيه", "EGP")}` : null].filter(Boolean).join(": ");
  return {
    id: p.id,
    name: p.name,
    name_en: p.name_en || null,
    developer: p.developer_name || null,
    place: [p.district, p.city].filter(Boolean).join(" · "),
    governorate: p.governorate || null,
    status: p.status,
    delivery,
    price_from: p.price_from != null ? Number(p.price_from) : null,
    cover_url: p.cover_url ? require("../lib/supabase").photoUrl(p.cover_url) : null,
    facts,
    // The raw figures for the card's key numbers (the same values as the facts above).
    stats: {
      bedrooms: (p.bedroom_options || []).map(Number),
      down_pct: p.down_pct_min != null ? Number(p.down_pct_min) : null,
      years: p.years_max != null ? Number(p.years_max) : null,
      acres: p.area_acres != null ? Number(p.area_acres) : null,
      types: (p.property_types || []).map((t) => typeLabel(t, lang))
    },
    discount_pct: p.discount_pct != null ? Number(p.discount_pct) : null,
    offers,
    offers_total: g.offers_total,
    free_text: free,
    matched: g.matched || [],
    client_text: clientText,
    updated_at: p.updated_at
  };
}

/**
 * The catalogue list in the same card shape as the results: the website's and the app's catalogue filters (place id, features, developer, bedrooms, price up to,
 * words, archived) with no "something must be asked" rule, 20 a page by name. Each card also carries units (active units) and plans (payment plans).
 * → { total_projects, page, pages, per_page, projects: [card + { units, plans, archived }] }
 */
async function browse(pool, actor, opts = {}) {
  const Catalogue = require("./catalogue");
  const r = await Catalogue.listProjectsPage(pool, actor, opts);
  const lang = actor.preferred_lang === "en" ? "en" : "ar";
  return {
    total_projects: r.total,
    page: r.page,
    pages: r.pages,
    per_page: 20,
    projects: r.items.map((row) => ({
      ...card({ project: { ...row, developer_name: lang === "en" ? row.developer_name_en || row.developer_name_ar : row.developer_name_ar || row.developer_name_en }, offers: [], offers_total: 0, matched: [] }, { lang, numbers: [] }),
      units: row.units,
      plans: row.plans,
      offers_count: row.offers,
      archived: Boolean(row.archived_at)
    }))
  };
}

// The filters a chip stands for (a chip can be dropped with ?drop=place,area,price,down,inst).
const DROPS = { place: ["locations", "places", "place_terms"], area: ["area_min", "area_max"], price: ["price_min", "price_max"], down: ["max_down_payment"], inst: ["max_installment"], beds: ["bedrooms_min", "bedrooms_max"], features: ["features"] };

/**
 * The results of a question as the website and the app both ask for them: the question's filters (minus dropped chips), the page's explicit
 * filters over them, then search(). query: { q, sort, page, per, drop, pmin, pmax, amin, amax, dmax, imax, bed }.
 * → { chips: [{ key, value }], dropped, filters, ...search result }
 */
async function fromQuery(pool, broker, query = {}, { AI = null } = {}) {
  const Q = require("../domain/searchQuery");
  const SearchLink = require("../domain/searchLink");
  const q = String(query.q || "").trim().slice(0, 500);
  const t0 = Date.now();
  // A link back to an earlier results page (?f=) carries the reading: nothing is read or logged again. A new question is read by the AI first
  // and by the parser second (services/search.js parseRequest: the AI's reading is used when it answers, the parser's when it does not or the
  // switch or credit is off); both readings and their differences go to the search log (channel "ask") and the parser learns from the AI.
  let parse = null;
  let base = query.f ? SearchLink.decodeFilters(String(query.f)) : null;
  if (!base) {
    const Search = require("./search");
    const Switches = require("./aiSwitches");
    parse = await Search.parseRequest(AI, { text: q, ctx: { pool, AI, broker, lang: broker.preferred_lang === "en" ? "en" : "ar" }, aiAllowed: Boolean(AI) && (await Switches.isOn(pool, broker.agency_id, "search_ai").catch(() => false)), neverCharge: true }).catch(() => null);
    base = parse ? parse.parsed.filters : Q.fallbackParse(q).filters;
  }
  const token = SearchLink.encodeFilters(base);
  const f = JSON.parse(JSON.stringify(base));
  const dropped = String(query.drop || "").split(",").filter((k) => DROPS[k]);
  for (const k of dropped) for (const key of DROPS[k]) f[key] = Array.isArray(f[key]) ? [] : null;
  const explicit = {};
  for (const k of [...Object.keys(EXPLICIT), "bed"]) if (query[k] !== undefined && query[k] !== "") explicit[k] = query[k];
  const filters = mergeExplicit(f, explicit);
  const chips = Object.entries(DROPS)
    .filter(([k]) => !dropped.includes(k))
    .map(([k, keys]) => [k, Object.fromEntries(keys.map((key) => [key, filters[key]]).filter(([, v]) => (Array.isArray(v) ? v.length : v != null)))])
    .filter(([, v]) => Object.keys(v).length)
    .map(([key, value]) => ({ key, value }));
  const lang = broker.preferred_lang === "en" ? "en" : "ar";
  const r = await search(pool, broker.agency_id, filters, { sort: query.sort, page: query.page, perPage: query.per, q, lang, developer: /^[0-9a-f-]{36}$/i.test(query.dev || "") ? query.dev : null, unitsOnly: query.units === "1" });
  let logId = null;
  if (parse) {
    const SearchLog = require("./searchLog");
    logId = await SearchLog.record(pool, { broker, channel: "ask", text: q, parse: { ...parse, timings: { parseMs: parse.ms } }, startedAt: t0, used: filters, total: r.total_projects, ids: r.projects.map((p) => p.id) });
    if (logId && AI) require("./searchShadow").schedule(pool, AI, { logId, text: q, parse });
  }
  // Links back to a results page carry the first search's log id (sl), so what the broker does next belongs to that search.
  if (!logId && /^[0-9a-f-]{36}$/i.test(String(query.sl || ""))) logId = String(query.sl);
  return { token, log_id: logId, read: parse ? { source: parse.source, disagree: parse.disagree || [] } : { source: "link", disagree: [] }, chips, dropped, filters: { price_min: filters.price_min ?? null, price_max: filters.price_max ?? null, area_min: filters.area_min ?? null, area_max: filters.area_max ?? null, max_down_payment: filters.max_down_payment ?? null, max_installment: filters.max_installment ?? null, bedrooms: filters.bedrooms_min ?? null }, ...r };
}

module.exports = { search, browse, fromQuery, mergeExplicit, SORTS, EXPLICIT, DROPS };
