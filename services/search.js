// services/search.js — The one search service (WhatsApp text, voice, and later the web). Returns data.
// Same input → same filters → same SQL → same ids in the same order.
"use strict";

const Q = require("../domain/searchQuery");
const Vis = require("../lib/visibility");
const PlaceNames = require("../lib/placeNames");
const Fx = require("./fx");
const Switches = require("./aiSwitches");
const Vocab = require("./searchVocab");

const PAGE_SIZE = 5;
// Telegram messages are free, so a Telegram search shows twice as many units per message.
const TG_PAGE_SIZE = 10;
const SEARCH_STATUSES = ["active", "sold", "archived"];
// AC and kitchen requests (Haytham 2026-11-12): the exact status first, then the closest ones, then furnished units (they have both),
// then units with nothing recorded. Semi-furnished counts as kitchen and AC. Other statuses are left out.
const FURNISHING_TIERS = {
  kitchen_and_ac: [["kitchen_and_ac"], ["ac_only", "kitchen_only"], ["furnished", "semi_furnished"]],
  ac_only: [["ac_only"], ["kitchen_and_ac", "semi_furnished"], ["furnished"]],
  kitchen_only: [["kitchen_only"], ["kitchen_and_ac", "semi_furnished"], ["furnished"]],
  // Semi-furnished usually means kitchen and AC (Haytham 2026-11-12); furnished is followed by semi-furnished.
  semi_furnished: [["semi_furnished"], ["kitchen_and_ac"], ["ac_only"], ["kitchen_only"]],
  furnished: [["furnished"], ["semi_furnished"]]
};
const FURNISHING_KEYS = { kitchen_and_ac: ["kitchen_installed", "ac_installed"], ac_only: ["ac_installed"], kitchen_only: ["kitchen_installed"], semi_furnished: ["kitchen_installed", "ac_installed"], furnished: [] };
// "Fully finished" is also answered by the finishes above it (Haytham 2026-11-12), after the exact ones.
const FINISHING_ALSO = { fully_finished: ["super_lux", "ultra_super_lux"] };
const SOFT_FEATURE_KEYS = new Set(require("../domain/features").FEATURES.filter((f) => f.group === "equipment" || f.group === "outdoor").map((f) => f.key));
const SNAPSHOT_MAX = 100; // ids remembered for "more" (B1)
const STEP_MONTHS_SQL = `CASE p->>'frequency' WHEN 'monthly' THEN 1 WHEN 'semi_annual' THEN 6 WHEN 'annual' THEN 12 ELSE 3 END`;

const SEARCH_PROMPT = (featureList) => `You are the search-understanding layer of a WhatsApp real-estate inventory bot used by Egyptian brokers.
Read the broker's request (Arabic, English or mixed; typed or transcribed) and return ONE JSON object.
Never invent a filter that was not asked for.

{
  "intent": "search" | "listing" | "other",   // "other" for greetings, thanks, small talk; "listing" when the broker is describing a unit to add
  "transcript": "the request as written or heard",
  "language": "ar" | "en",
  "filters": {
    "code": "a unit code if asked for one (e.g. N4-105), else null",
    "listing_type": "sale" | "rent" | null,
    "market": "primary" | "resale" | null,
    "property_types": [ any of: apartment, duplex, penthouse, chalet, studio, villa, twin_villa, townhouse, office, shop, clinic, commercial, land ],
    "compound": "ONE compound / project name, written in English (translate an Arabic name to its usual English spelling), else null",
    "locations": [ other place names (areas, districts, cities), in English where the usual English name is known ],
    "currency": "EGP" | "USD" | "EUR" | null,
    "price_min": number or null, "price_max": number or null,
    "area_min": number or null, "area_max": number or null,
    "bedrooms_min": integer or null, "bedrooms_max": integer or null,
    "bathrooms_min": integer or null,
    "floor_min": integer or null, "floor_max": integer or null,   // ground floor = 0
    "finishing": [ any of: core_and_shell, semi_finished, fully_finished, super_lux, ultra_super_lux ],
    "furnishing": "furnished" | "semi_furnished" | "unfurnished" | null,
    "delivery": { "ready": true or null, "off_plan": true or null, "by_year": integer or null },
    "payment": { "cash": true or null, "installments": true or null, "years": integer or null, "down_pct": number or null, "max_down_payment": number or null, "max_installment": number or null },
    "features": [ keys from this list only: ${featureList} ],
    "other_features": [ other requested extras, as said ]
  }
}

RULES:
- Numbers are EGP unless the request names dollars or euros: "8 مليون ونص" = 8500000, "مقدم 500 ألف" → payment.max_down_payment 500000, "قسط مش أكتر من 150 ألف" → payment.max_installment 150000, "في حدود 6 مليون" → price_max 6000000.
- "3 غرف" or "3 bedrooms" → bedrooms_min 3 and bedrooms_max null (3 or more).
- "متكرر" / "typical" floor → floor_min 1 and floor_max null (any floor except ground). Same for bathrooms ("3 حمامات" → bathrooms_min 3) and area ("150 متر" → area_min 150, area_max null). A range ("من 120 لـ 150 متر") sets both ends. "استوديو" → property_types ["studio"].
- "budget" / "حدود" / "تحت" / "لحد" with a price → price_max only.
- Dollars ("$", "USD", "دولار") → currency "USD"; euros ("€", "EUR", "يورو") → currency "EUR". Keep the number exactly as said ("1000 دولار" = price_max 1000 with currency "USD"). Never convert it to EGP yourself. No currency named means EGP.
- "تحت الإنشاء" / "off plan" / "under construction" → delivery.off_plan true. "استلام فوري" / "ready to move" → delivery.ready true. "تسليم 2027" → delivery.by_year 2027.
- Units are searched by their English text for now, so a compound or area said in Arabic must come back in its English spelling (e.g. "ازاد" → "Azad").
- "على 8 سنين" / "8 years" / "٨ سنين" → payment.years 8 (the plan's length, not a place). Never put the word "سنين" in locations.
- "مقدم 10%" / "10% down" / "مقدم ١٠٪" → payment.down_pct 10 (a percent of the price, not an amount).
- بحري / north facing → "north_facing"; ناصية / corner → "corner"; غرفة مربية / nanny room → "nanny_room".
- "Lake View" is a compound: "compound": "Lake View". It is the lake-view feature ("view_lagoon") ONLY in "overlooking lake", "with lake view", "فيو بحيرة" and "فيو على بحيرة"; then do not put it in compound.
- "20m" / "20 م" / "20M" with no word like متر, sqm or m2 means twenty million (price_max 20000000), never 20 square metres. An area is written with متر / sqm / m2, or is 30 or more.
- "budget" / "بادجت" / "ميزانية" with a number is a price ceiling (price_max), never an installment. A monthly installment is set only when the request says "قسط" / "installment".
- Names may be misspelled or written in Arabic letters; give the usual English spelling of the compound, and if you do not know a place put it in "locations" as said. Never guess a place you do not know.
- Exclusions are NEVER filters: what follows "بدون" / "من غير" / "مش في" / "without" / "not" is left out completely ("شقة بدون مصعد" → apartment only, no elevator feature). "الدور الاخير" / "last floor" and "قانون جديد" / "new rent law" are also left out.`;

function featureListForPrompt() {
  const Features = require("../domain/features");
  return Features.FEATURES.map((f) => `${f.key} (${f.ar} / ${f.en})`).join(", ");
}

/**
 * Reads a request. The local parser goes first: when it is sure (every word and number used), its answer is the answer
 * and no AI call (no credit) is made. When it is unsure, or the broker asks for it (forceAi), the AI reads the request;
 * if the AI fails or is switched off, the local answer stands.
 * @returns {Promise<{ parsed, source: "parser"|"ai"|"fallback", modelUsed, usage, ms, local, ai, reasons }>}
 *   source "fallback" = the parser was unsure, the AI could not answer. local / ai keep both readings for the search log.
 */
// During the POC the AI reads every search and the quick reader runs beside it; the two readings are compared and kept in the
// search log. SEARCH_AI_FIRST=false goes back to the quick reader first (the AI only when it is unsure or asked).
const aiFirst = () => !/^(0|false|off|no)$/i.test(String(process.env.SEARCH_AI_FIRST ?? "true"));
const aiFirstDailyMax = () => Math.max(0, Number(process.env.SEARCH_AI_FIRST_DAILY_MAX) || 2000);
let capCache = { at: 0, n: 0 };
async function underAiFirstCap(pool) {
  if (!pool) return true;
  if (Date.now() - capCache.at > 60000) {
    try {
      const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM search_log WHERE created_at > now() - interval '1 day' AND source = 'ai' AND ai_filters IS NOT NULL");
      capCache = { at: Date.now(), n: rows[0].n };
    } catch {
      capCache = { at: Date.now(), n: 0 };
    }
  }
  return capCache.n < aiFirstDailyMax();
}

/**
 * Reads a request. The quick (local) reader always reads it. In AI-first mode the AI reads it too and its answer is used; the
 * agency pays no credit for that read (it runs with no broker in its context, like the quiet check), and the differences
 * between the two readings are kept for the search log. When the AI fails or is switched off, the quick reading stands and
 * `aiError` says why. A read the broker asked for ("Search with AI") or one the quick reader is unsure of is charged as before.
 * @returns {Promise<{ parsed, source: "parser"|"ai"|"fallback", modelUsed, usage, ms, local, ai, reasons, disagree, aiError }>}
 */
async function parseRequest(AI, { text = "", ctx = {}, forceAi = false, aiAllowed = true } = {}) {
  const t0 = Date.now();
  if (ctx.pool) await Vocab.ensureLoaded(ctx.pool);
  const local = Q.fallbackParse(text);
  const reasons = local.meta?.reasons || [];
  // The agency owner's switch for AI help in search (a switched-off search never reaches the AI or spends a credit).
  if (aiAllowed && ctx.pool && ctx.broker?.agency_id) aiAllowed = await Switches.isOn(ctx.pool, ctx.broker.agency_id, "search_ai");
  const charged = forceAi || Boolean(local.meta?.unsure);
  const free = !charged && aiAllowed && local.intent !== "other" && aiFirst() && (await underAiFirstCap(ctx.pool));
  if (!aiAllowed || (!charged && !free)) {
    return { parsed: local, source: "parser", modelUsed: "local_parser", usage: {}, ms: Date.now() - t0, local, ai: null, reasons, disagree: [] };
  }
  try {
    const res = await AI.generateWithCascade({
      contents: [
        {
          role: "user",
          parts: [{ text: `${SEARCH_PROMPT(featureListForPrompt())}\n\n===USER_QUERY===\n${String(text).trim()}\n===USER_QUERY===` }]
        }
      ],
      config: { responseMimeType: "application/json", temperature: 0 },
      operationType: "search_parse",
      ctx: free ? { pool: ctx.pool } : ctx
    });
    const raw = JSON.parse(String(res.text || "").replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
    const parsed = Q.enforceMillionUnits(Q.enforceInstallmentWords(Q.normalizeAiSearch(raw), text), text);
    if (!parsed.transcript) parsed.transcript = String(text).slice(0, 500);
    // Phrases the filters cannot say are the parser's to report; the AI reading carries them over.
    parsed.meta = { ...(local.meta || {}), unsure: false };
    return { parsed, source: "ai", modelUsed: res.modelUsed, usage: res.usage || {}, ms: Date.now() - t0, local, ai: parsed, reasons, disagree: Q.disagreements(local, parsed) };
  } catch (err) {
    console.warn("AI search parsing failed, using the local parser:", err.message);
    return { parsed: local, source: "fallback", modelUsed: "fallback_regex", usage: {}, ms: Date.now() - t0, local, ai: null, reasons, disagree: [], aiError: err.code || "ai" };
  }
}

/**
 * Builds the search SQL. Every condition is agency-scoped and active-only.
 * relaxed widens price/area ±15%, bedrooms ±1 and drops finishing/furnishing/floor/bathrooms.
 */
function buildSearchQuery(agencyId, parsedOrFilters, { limit = SNAPSHOT_MAX, offset = 0, relaxed = false, onlyIds = null, fx = {}, status = "active" } = {}) {
  const f = Q.ensureFilters(parsedOrFilters?.filters ? parsedOrFilters : { filters: parsedOrFilters || {} });
  // Available is the default; Sold and Archived are looked at on purpose (never by the match sweep or client links).
  // The status is one of three fixed words (never user text), so it is written into the SQL and the parameters keep their numbers.
  const where = ["l.agency_id = $1", `l.status = '${SEARCH_STATUSES.includes(status) ? status : "active"}'`];
  const params = [agencyId];
  const add = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  // The match sweep: the same filters, restricted to the units that changed (step 7).
  if (onlyIds) where.push(`l.id = ANY(${add(onlyIds)}::uuid[])`);
  let rank = "";
  let typeRank = "";
  let exactFirst = "";

  if (f.code) {
    // B6/B7: case-folded code through the unique (agency_id, code_norm) index.
    const c = add(Q.normalizeCode(f.code));
    where.push(`(l.code_norm = ${c} OR upper(l.developer_unit_code) = ${c})`);
  } else {
    if (f.listing_type) where.push(`l.listing_type = ${add(f.listing_type)}`);
    if (f.market) where.push(`l.market = ${add(f.market)}`);
    if (f.property_types.length) where.push(`l.property_type = ANY(${add(f.property_types)}::text[])`);
    // The searched type first, then the rest of its family (domain/searchQuery.js TYPE_FAMILIES).
    if ((f.property_type_order || []).length > 1) {
      const whens = f.property_type_order.map((t, i) => `WHEN ${add(t)} THEN ${i}`).join(" ");
      typeRank = `CASE l.property_type ${whens} ELSE ${f.property_type_order.length} END, `;
    }

    // A place word that named an area or sub-zone (services/areaSearch.js) filters on the unit's area columns.
    const areaScope = (parsedOrFilters?.filters || parsedOrFilters || {}).area_scope;
    if (areaScope && (areaScope.areas?.length || areaScope.subzones?.length)) {
      where.push(`(l.area_id = ANY(${add(areaScope.areas || [])}::uuid[]) OR l.subzone_id = ANY(${add(areaScope.subzones || [])}::uuid[]))`);
    }

    // Places: resolved keys use the indexed key columns; free place words use the search document.
    if (f.places.length) {
      const ors = f.places.map((p) => {
        const col = { compound: "compound_key", developer: "developer_key", area: "area_key" }[p.kind];
        return `l.${col} = ${add(p.key)}`;
      });
      where.push(`(${ors.join(" OR ")})`);
    } else if (f.place_terms.length) {
      const ors = f.place_terms.map((t) => {
        const p = add(t);
        return `(l.search_text_normalized LIKE '%' || ${p} || '%' OR ${p} <% l.search_text_normalized)`;
      });
      where.push(`(${ors.join(" OR ")})`);
      rank = `GREATEST(${f.place_terms.map((t) => `word_similarity(${add(t)}, l.search_text_normalized)`).join(", ")}) DESC,`;
    }

    // Prices are compared in EGP: a dollar or euro unit is converted with the agency's rate, and a budget in dollars or
    // euros is converted the same way. A unit or budget with no rate set matches no price (see domain/fx.js).
    // Built only where a price condition uses it, so no unused parameter is sent.
    const priceEgp = () => `(CASE coalesce(l.details->>'currency', 'EGP')
        WHEN 'EGP' THEN l.price_value
        WHEN 'USD' THEN l.price_value * ${add(fx.USD ?? null)}::numeric
        WHEN 'EUR' THEN l.price_value * ${add(fx.EUR ?? null)}::numeric END)`;
    const qRate = f.currency && f.currency !== "EGP" ? fx[f.currency] ?? null : 1;
    if (qRate === null && (f.price_min !== null || f.price_max !== null)) where.push("FALSE");
    const toEgp = (v) => (v === null || qRate === null ? null : Math.round(v * qRate));
    const widen = (v, k) => (v === null ? null : relaxed ? Math.round(v * k) : v);
    const pMin = widen(toEgp(f.price_min), 0.85);
    const pMax = widen(toEgp(f.price_max), 1.15);
    if (pMin !== null) where.push(`${priceEgp()} >= ${add(pMin)}`);
    if (pMax !== null) where.push(`${priceEgp()} <= ${add(pMax)}`);
    const aMin = widen(f.area_min, 0.85);
    const aMax = widen(f.area_max, 1.15);
    // A unit with no area, bedrooms, bathrooms or floor recorded still matches (it is not dropped).
    if (aMin !== null) where.push(`(l.area_value IS NULL OR l.area_value >= ${add(aMin)})`);
    if (aMax !== null) where.push(`(l.area_value IS NULL OR l.area_value <= ${add(aMax)})`);

    if (f.bedrooms_min !== null && f.bedrooms_min === f.bedrooms_max) {
      if (f.bedrooms_min === 0) where.push(`(l.bedrooms IS NULL OR l.bedrooms = 0 OR l.property_type = 'studio')`);
      else if (relaxed) where.push(`(l.bedrooms IS NULL OR l.bedrooms BETWEEN ${add(Math.max(1, f.bedrooms_min - 1))} AND ${add(f.bedrooms_max + 1)})`);
      else where.push(`(l.bedrooms IS NULL OR l.bedrooms = ${add(f.bedrooms_min)})`);
    } else {
      if (f.bedrooms_min !== null) where.push(`(l.bedrooms IS NULL OR l.bedrooms >= ${add(relaxed ? Math.max(0, f.bedrooms_min - 1) : f.bedrooms_min)})`);
      if (f.bedrooms_max !== null) where.push(`(l.bedrooms IS NULL OR l.bedrooms <= ${add(relaxed ? f.bedrooms_max + 1 : f.bedrooms_max)})`);
    }

    if (!relaxed) {
      if (f.bathrooms_min !== null) where.push(`(l.bathrooms IS NULL OR l.bathrooms >= ${add(f.bathrooms_min)})`);
      // Floor 0 is ground; "typical" arrives as floor_min 1 (any floor above ground). Units with no floor still match.
      if (f.floor_min !== null) where.push(`(l.floor_level IS NULL OR l.floor_level >= ${add(f.floor_min)})`);
      if (f.floor_max !== null) where.push(`(l.floor_level IS NULL OR l.floor_level <= ${add(f.floor_max)})`);
      // A blank finishing or furnishing matches both sides of the filter (only the special fields stay strict).
      if (f.finishing.length) {
        const fin = add(f.finishing);
        const also = [...new Set(f.finishing.filter((x) => FINISHING_ALSO[x]).flatMap((x) => FINISHING_ALSO[x]).filter((x) => !f.finishing.includes(x)))];
        where.push(`(l.finishing IS NULL OR l.finishing = ANY(${also.length ? add([...f.finishing, ...also]) : fin}::text[]))`);
        // Exact finishing first, then the finishes above it, then the units whose finishing is blank (an unmapped old entry became blank).
        const alsoWhens = also.map((x, i) => `WHEN l.finishing = ${add(x)} THEN ${i + 1}`).join(" ");
        exactFirst += `CASE WHEN l.finishing = ANY(${fin}::text[]) THEN 0 ${alsoWhens} ELSE ${also.length + 1} END, `;
      }
      if (f.furnishing) {
        const tiers = FURNISHING_TIERS[f.furnishing];
        if (tiers) {
          where.push(`(l.furnishing IS NULL OR l.furnishing = ANY(${add(tiers.flat())}::text[]) OR l.furnishing = ${add(f.furnishing)})`);
          // Exact status (or the extras recorded on the unit) first, then each tier, then units with nothing recorded.
          const keys = FURNISHING_KEYS[f.furnishing] || [];
          const ownWhen = keys.length ? ` OR (l.furnishing IS NULL AND l.feature_keys @> ${add(keys)}::text[])` : "";
          const whens = tiers.slice(1).map((t, i) => `WHEN l.furnishing = ANY(${add(t)}::text[]) THEN ${i + 1}`).join(" ");
          exactFirst += `CASE WHEN l.furnishing = ANY(${add(tiers[0])}::text[])${ownWhen} THEN 0 ${whens} WHEN l.furnishing IS NULL THEN ${tiers.length} ELSE ${tiers.length + 1} END, `;
        } else {
          where.push(`(l.furnishing IS NULL OR l.furnishing = ${add(f.furnishing)})`);
          // Exact status first, then the units whose status is blank (Haytham 2026-11-04).
          exactFirst += `CASE WHEN l.furnishing = ${add(f.furnishing)} THEN 0 ELSE 1 END, `;
        }
      }
    }

    if (f.delivery_ready === true) where.push(`l.is_ready = true`);
    // Off plan (تحت الإنشاء): not ready; a unit with no readiness set still matches.
    if (f.delivery_ready === false) where.push(`(l.is_ready IS NULL OR l.is_ready = false)`);
    if (f.delivery_by_year !== null) where.push(`(l.is_ready = true OR l.delivery_year <= ${add(f.delivery_by_year)})`);

    if (f.payment_cash) {
      where.push(`(coalesce(l.remaining_amount, 0) = 0 AND (l.market = 'resale' OR (l.payment_terms ? 'cash_price' AND l.payment_terms->>'cash_price' IS NOT NULL)))`);
    }
    if (f.payment_installments) {
      where.push(`(coalesce(l.remaining_amount, 0) > 0 OR jsonb_array_length(coalesce(l.payment_terms->'plans', '[]'::jsonb)) > 0)`);
    }
    if (f.payment_down_pct !== null) {
      // "مقدم 10%": a plan that asks exactly that down payment (resale units have no plan percent, so they are not matched).
      const d = add(f.payment_down_pct);
      where.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(l.payment_terms->'plans', '[]'::jsonb)) p
                WHERE (p->>'down_payment_pct')::numeric = ${d})`);
    }
    if (f.payment_years !== null) {
      // "على 8 سنين": a plan of that many years or more (or a resale with that many years left or more).
      const y = add(f.payment_years);
      where.push(`(l.installment_years >= ${y} OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(l.payment_terms->'plans', '[]'::jsonb)) p
                WHERE (p->>'years')::numeric >= ${y}))`);
    }
    if (f.max_down_payment !== null) {
      const p = add(f.max_down_payment);
      where.push(`(
        (l.market = 'resale' AND coalesce(nullif(l.down_payment_value, 0), l.price_value) <= ${p}) OR
        EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(l.payment_terms->'plans', '[]'::jsonb)) p
                WHERE (p->>'down_payment_pct')::numeric * l.price_value / 100 <= ${p})
      )`);
    }
    if (f.max_installment !== null) {
      const p = add(f.max_installment);
      where.push(`(
        (l.installment_value IS NOT NULL AND l.installment_value <= ${p}) OR
        EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(l.payment_terms->'plans', '[]'::jsonb)) p
                WHERE (p->>'years')::numeric > 0
                  AND l.price_value * (100 - coalesce((p->>'down_payment_pct')::numeric, 0)) / 100
                      / ((p->>'years')::numeric * 12 / ${STEP_MONTHS_SQL}) <= ${p})
      )`);
    }

    // "furnished" is already the furnishing filter; requiring the feature key too dropped units that had only one of them.
    const featureKeys = f.furnishing ? f.features.filter((k) => k !== "furnished") : f.features;
    // Lake View is a compound: the lake-view feature also matches that compound's units.
    const plainKeys = featureKeys.filter((k) => k !== "view_lagoon");
    // Extras rank, they do not hide (Haytham 2026-11-12): a unit with no extras recorded still shows, after the ones that have them.
    // Only equipment and outdoor extras are soft; orientation, layout, view and building facts stay strict.
    const softKeys = plainKeys.filter((k) => SOFT_FEATURE_KEYS.has(k));
    const hardKeys = plainKeys.filter((k) => !SOFT_FEATURE_KEYS.has(k));
    if (hardKeys.length) where.push(`l.feature_keys @> ${add(hardKeys)}::text[]`);
    if (softKeys.length) {
      const k = add(softKeys);
      where.push(`(coalesce(cardinality(l.feature_keys), 0) = 0 OR l.feature_keys @> ${k}::text[])`);
      exactFirst += `CASE WHEN l.feature_keys @> ${k}::text[] THEN 0 ELSE 1 END, `;
    }
    if (featureKeys.includes("view_lagoon")) where.push(`(l.feature_keys @> ARRAY['view_lagoon']::text[] OR l.compound_key = 'lake_view')`);
    for (const t of f.feature_terms) {
      const like = `l.search_text_normalized LIKE '%' || ${add(t)} || '%'`;
      // A swimming pool asked for plainly also matches a private pool.
      where.push(t === "حمام سباحه" ? `(l.feature_keys @> ARRAY['private_pool']::text[] OR ${like})` : like);
    }
  }

  // An exact bedroom count (e.g. 2) lists that count first, then larger counts (3, 4...), then the rest (near matches, unknown).
  // A plain count ("2 bedrooms") is parsed as 2 or more, so the open-ended form counts too.
  const bedRank = f.bedrooms_min > 0 && (f.bedrooms_max == null || f.bedrooms_max === f.bedrooms_min)
    ? `CASE WHEN l.bedrooms - ${add(f.bedrooms_min)} = 0 THEN 0 WHEN l.bedrooms - ${add(f.bedrooms_min)} > 0 THEN l.bedrooms - ${add(f.bedrooms_min)} ELSE 100 END, `
    : "";
  const sql = `
    SELECT l.*, COUNT(*) OVER() AS total_count
    FROM listings l
    WHERE ${Vis.units("l")} AND ${where.join("\n      AND ")}
    ORDER BY ${rank} ${bedRank} ${typeRank} ${exactFirst} l.confirmed_at DESC NULLS LAST, l.created_at DESC, l.id DESC
    LIMIT ${add(limit)} OFFSET ${add(offset)}`;
  return { sql, params };
}

/**
 * Runs a search: strict pass, then a relaxed pass when strict finds nothing.
 * Words nobody knows (a place or extra the dictionaries and the units do not know) are never dropped silently. With `ask`
 * the answer comes back as `ask: { terms, withoutTotal }` and no rows, so the broker is asked; without it (a saved link, a
 * "search without it" choice) the search is repeated without those words and `ignoredTerms` says which were left out.
 * @returns {Promise<{ rows, ids, total, relaxed, dbMs, ask }>} rows = first page, ids = snapshot for "more"
 */
async function runSearch(pool, agencyId, parsed, { pageSize = PAGE_SIZE, ask = false, status = "active" } = {}) {
  const t0 = Date.now();
  let relaxed = false;
  // A word that is an approved compound name (lib/placeNames.js) searches in both its languages.
  if (parsed.filters.place_terms?.length && !parsed.filters.places?.length) {
    parsed.filters.place_terms = await PlaceNames.widenSearchTerms(pool, parsed.filters.place_terms);
    // A word that is the name or alias of one area or sub-zone filters on the unit's area (services/areaSearch.js).
    const byArea = await require("./areaSearch").scope(pool, parsed.filters.place_terms);
    if (byArea.scope) {
      parsed.filters.area_scope = byArea.scope;
      parsed.filters.place_terms = byArea.rest;
    }
  }
  const fx = await Fx.loadRates(pool, agencyId);
  let { sql, params } = buildSearchQuery(agencyId, parsed, { fx, status });
  let { rows } = await pool.query(sql, params);
  if (!rows.length && !parsed.filters.code) {
    ({ sql, params } = buildSearchQuery(agencyId, parsed, { relaxed: true, fx, status }));
    ({ rows } = await pool.query(sql, params));
    relaxed = rows.length > 0;
  }
  // Soft words: a place or extra the dictionaries do not know ("المعادي", "اخر دور"). When a place was found, the query ignores
  // the unknown place words; when nothing matched, the unknown words are what emptied the answer.
  let ignoredTerms = [];
  const f0 = parsed.filters;
  const placeFound = (f0.places || []).length > 0 || Boolean(f0.area_scope);
  const soft = [...(placeFound ? [] : f0.place_terms || []), ...(f0.feature_terms || [])];
  const unusedPlaceWords = placeFound ? f0.place_terms || [] : [];
  const unknown = [...(!rows.length ? soft : []), ...unusedPlaceWords];
  if (unknown.length && !f0.code) {
    const rest = { ...parsed, filters: { ...f0, place_terms: [], feature_terms: [] } };
    let restRows = rows;
    let restRelaxed = relaxed;
    if (!rows.length || soft.length) {
      if (Q.hasAnyFilter(rest)) {
        ({ sql, params } = buildSearchQuery(agencyId, rest, { fx, status }));
        ({ rows: restRows } = await pool.query(sql, params));
        restRelaxed = false;
        if (!restRows.length) {
          ({ sql, params } = buildSearchQuery(agencyId, rest, { relaxed: true, fx, status }));
          ({ rows: restRows } = await pool.query(sql, params));
          restRelaxed = restRows.length > 0;
        }
      } else restRows = [];
    }
    if (ask) {
      const total = restRows.length ? Number(restRows[0].total_count) : 0;
      const rateMissing = await Fx.missingRates(pool, agencyId, fx);
      return { rows: [], ids: [], total: 0, relaxed: false, ignoredTerms: [], rateMissing, dbMs: Date.now() - t0, ask: { terms: [...new Set(unknown)], withoutTotal: total } };
    }
    if (restRows.length || (rows.length && unusedPlaceWords.length)) {
      ignoredTerms = [...new Set(unknown)];
      rows = restRows.length ? restRows : rows;
      relaxed = restRows.length ? restRelaxed : relaxed;
      parsed.filters.place_terms = [];
      parsed.filters.feature_terms = [];
    }
  }
  const total = rows.length ? Number(rows[0].total_count) : 0;
  const rateMissing = await Fx.missingRates(pool, agencyId, fx);
  return { rows: rows.slice(0, pageSize), ids: rows.map((r) => r.id), total, relaxed, ignoredTerms, rateMissing, dbMs: Date.now() - t0, ask: null };
}

/**
 * Next page from an id snapshot (B1): stable order and no repeats even if inventory changed.
 * Units whose status changed since (sold or archived while looking at Available) are skipped.
 */
async function pageByIds(pool, agencyId, ids, offset, pageSize = PAGE_SIZE, { status = "active" } = {}) {
  const slice = ids.slice(offset, offset + pageSize);
  if (!slice.length) return [];
  const { rows } = await pool.query(
    `SELECT l.* FROM listings l
     WHERE ${Vis.units("l")} AND l.agency_id = $1 AND l.status = '${SEARCH_STATUSES.includes(status) ? status : "active"}' AND l.id = ANY($2::uuid[])
     ORDER BY array_position($2::uuid[], l.id)`,
    [agencyId, slice]
  );
  return rows;
}

/**
 * How many units of one status fit the same filters (strict pass only): the number on the "Sold" button. 0 when none.
 * The filters are the ones the available results were built with, so words that were left out stay left out.
 */
async function countByStatus(pool, agencyId, parsed, status) {
  if (!SEARCH_STATUSES.includes(status)) return 0;
  const { sql, params } = buildSearchQuery(agencyId, parsed, { status, limit: 1, fx: await Fx.loadRates(pool, agencyId) });
  const { rows } = await pool.query(sql, params);
  return rows.length ? Number(rows[0].total_count) : 0;
}

/**
 * The whole search for one request: parse → intent guard → run.
 * @returns {Promise<{ status: "results"|"none"|"small_talk"|"listing", parsed, source, rows, ids, total, relaxed, timings }>}
 */
async function search({ pool, AI, agencyId, text, ctx = {}, pageSize = PAGE_SIZE, forceAi = false, aiAllowed = true, allowDrop = false, status = "active" }) {
  const parse = await parseRequest(AI, { text, ctx, forceAi, aiAllowed });
  const intent = Q.classifyIntent(parse.parsed);
  const base = { parsed: parse.parsed, source: parse.source, modelUsed: parse.modelUsed, usage: parse.usage, local: parse.local, ai: parse.ai, reasons: parse.reasons, disagree: parse.disagree || [], aiError: parse.aiError || null };
  // A budget with no unit ("budget 50") is never guessed: ask which unit was meant, and show how many units fit without the budget.
  const budgetUnit = (parse.parsed?.meta?.ambiguous || []).some((a) => a.kind === "budget");
  if (budgetUnit && intent !== "listing" && !allowDrop) {
    const without = await runSearch(pool, agencyId, parse.parsed, { pageSize, ask: false, status });
    return { ...base, rows: [], ids: [], total: 0, relaxed: false, status: "ask", ask: { terms: [], numbers: [], withoutTotal: without.total }, timings: { parseMs: parse.ms, dbMs: without.dbMs } };
  }
  if (intent !== "search") return { ...base, status: intent, rows: [], ids: [], total: 0, relaxed: false, timings: { parseMs: parse.ms, dbMs: 0 } };
  const res = await runSearch(pool, agencyId, parse.parsed, { pageSize, ask: !allowDrop, status });
  // The AI could not answer and the quick reader left a number it could not place ("بادجت 70000"): ask, never search without it.
  const numbers = parse.source === "fallback" && !allowDrop ? parse.local?.meta?.leftover_numbers || [] : [];
  if (numbers.length) res.ask = { terms: res.ask?.terms || [], numbers, aiDown: true, withoutTotal: res.ask ? res.ask.withoutTotal : res.total };
  if (res.ask) return { ...base, ...res, rows: [], ids: [], total: 0, status: "ask", timings: { parseMs: parse.ms, dbMs: res.dbMs } };
  return { ...base, ...res, status: res.rows.length ? "results" : "none", timings: { parseMs: parse.ms, dbMs: res.dbMs } };
}

module.exports = {
  PAGE_SIZE,
  TG_PAGE_SIZE,
  SNAPSHOT_MAX,
  SEARCH_PROMPT,
  parseRequest,
  SEARCH_STATUSES,
  buildSearchQuery,
  countByStatus,
  runSearch,
  pageByIds,
  search
};
