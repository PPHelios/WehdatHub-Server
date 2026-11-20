// services/imports.js — Excel diff import and group import (forwarded posts / chat export). Returns data.
// A plan is computed, stored in web_imports and shown; applying it re-checks every row under the same
// locks and rules as WhatsApp: createListing (insert-only) and applyListingPatch (optimistic lock).
"use strict";

const L = require("../lib/listing");
const Store = require("../lib/listingStore");
const Edits = require("../lib/edits");
const Authz = require("../lib/authz");
const AiBlock = require("../lib/aiBlock");
const U = require("../lib/util");
const Rules = require("../domain/fieldRules");
const Describe = require("../domain/describe");
const Features = require("../domain/features");
const Delivery = require("../domain/delivery");
const SheetImport = require("../domain/sheetImport");
const ChatListing = require("../domain/chatListing");
const Mixed = require("../domain/sheetMixed");
const SheetGrid = require("../lib/sheetGrid");
const Dup = require("../domain/unitDuplicate");
const { normalizeCode } = require("../domain/searchQuery");
const { normalizeSearch } = require("../domain/searchText");
const Supabase = require("../lib/supabase");
const PhotoHash = require("./photoHash");
const ParseLog = require("./chatParseLog");
const Decisions = require("./chatDecisions");
const { MAX_PHOTOS } = require("../lib/images");
const Vis = require("../lib/visibility");

const MONEY = ["price_value", "down_payment_value", "remaining_amount", "installment_value"];
const DETAIL_LABELS = { owner_name: ["المالك", "Owner"], owner_phone: ["تليفون المالك", "Owner phone"], notes: ["ملاحظات", "Notes"], clean_summary: ["الوصف", "Description"], summary_en: ["الوصف بالإنجليزي", "English summary"], floor: ["الدور", "Floor"] };
const SIDE = { sale: ["بيع", "Sale"], rent: ["إيجار", "Rent"] };
const STATUS = { active: ["متاحة", "Available"], sold: ["مباعة", "Sold"], archived: ["مؤرشفة", "Archived"] };
const pick = (pair, lang) => (pair ? pair[lang === "en" ? 1 : 0] : null);

function display(col, v, lang) {
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return "—";
  if (MONEY.includes(col)) return Describe.money(v, lang) || String(v);
  if (col === "feature_keys") return v.map((k) => Features.featureLabel(k, lang)).join("، ");
  if (col === "finishing") return pick(Describe.FINISHING_LABELS[v], lang) || v;
  if (col === "status") return pick(STATUS[v], lang) || v;
  if (col === "listing_type") return pick(SIDE[v], lang) || v;
  if (col === "furnishing") return pick(Describe.FURNISHING_LABELS[v], lang) || v;
  if (col === "property_type") return pick(Describe.TYPE_LABELS[v], lang) || v;
  if (col === "installments_end") return String(v instanceof Date ? v.toISOString() : v).slice(0, 7);
  if (Array.isArray(v)) return v.join("، ");
  return String(v);
}

const DELIVERY_COLS = ["delivery_year", "delivery_quarter", "delivery_month", "is_ready", "delivery_raw"];
const HIDDEN_COLS = ["payment_terms", "inventory_type", "location_keywords", "price_display"];

/** Human list of what a patch changes: [{ field, label, from, to }]. */
function describeChanges(listing, patch, lang = "ar") {
  const out = [];
  for (const [col, to] of Object.entries(patch)) {
    if (HIDDEN_COLS.includes(col) || DELIVERY_COLS.includes(col)) continue;
    if (col === "details") {
      for (const k of Object.keys(DETAIL_LABELS)) {
        const a = listing.details?.[k] ?? null;
        const b = to?.[k] ?? null;
        if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ field: `details.${k}`, label: pick(DETAIL_LABELS[k], lang), from: display(k, a, lang), to: display(k, b, lang) });
      }
      continue;
    }
    const label = col === "status" ? pick(["الحالة", "Status"], lang) : pick(Edits.FIELD_LABELS[col], lang) || col;
    out.push({ field: col, label, from: display(col, listing[col], lang), to: display(col, to, lang) });
  }
  if (DELIVERY_COLS.some((c) => c in patch)) {
    const show = (l) => Delivery.formatDelivery(l, lang, { icon: false }) || "—";
    out.push({ field: "delivery", label: pick(["التسليم", "Delivery"], lang), from: show(listing), to: show({ ...listing, ...patch }) });
  }
  return out;
}

const stripLine = (t) => String(t || "").replace(/^``\s*·\s*/, "");
const same = (a, b) => Boolean(a) && Boolean(b) && normalizeSearch(a) === normalizeSearch(b);

/**
 * The agency export (lib/excel.js) writes the English compound and title when known and the raw text as
 * the description; such a value is the unit's own, not a change.
 */
function dropEchoes(existing, draft) {
  const d = existing.details || {};
  if (draft.compound && [existing.compound, existing.compound_en, d.compound_en].some((v) => same(v, draft.compound))) delete draft.compound;
  if (draft.title && [existing.title, d.title_en].some((v) => same(v, draft.title))) delete draft.title;
  if (draft.details?.clean_summary && [d.clean_summary, existing.raw_text].some((v) => same(v, draft.details.clean_summary))) delete draft.details.clean_summary;
  if (draft.details?.summary_en && same(d.summary_en, draft.details.summary_en)) delete draft.details.summary_en;
  if (draft.district && [existing.district, existing.city, existing.location].some((v) => same(v, draft.district))) delete draft.district;
  return draft;
}

/** A sheet row states the features column exactly (no union with the stored keys). */
function composeRow(existing, draft, lang) {
  const composed = L.composeFields({ existing, draft, lang });
  if ("feature_keys" in draft) {
    composed.feature_keys = Features.sortKeys(draft.feature_keys);
    composed.features_other = draft.features_other || [];
  }
  return composed;
}

// A simple missing field reads "Price is missing" (not just "Price"); a rule with its own sentence keeps it.
const SIMPLE_MISSING = new Set(["price_value", "monthly_rent", "area_value", "bua", "bedrooms", "location", "listing_type", "property_type"]);
const reasonOf = (b, lang) => (SIMPLE_MISSING.has(b.field) ? (lang === "en" ? `${b.label_en} is missing` : `${b.label_ar} ناقص`) : lang === "en" ? b.label_en : b.label_ar);
// The sheet cell that fixes each thing the rules ask for, so the edit form offers exactly what is missing.
const NEEDS = { listing_type: "listing_type", property_type: "property_type", location: "compound", area_value: "area_value", bua: "area_value", bedrooms: "bedrooms", monthly_rent: "price_value", price_value: "price_value", resale_two_of_three: "price_value", installments_question: "down_payment_value", primary_plan: "price_value" };
const needsOf = (blockers) => [...new Set(blockers.map((b) => NEEDS[b.field]).filter(Boolean))];
const ERROR_CELL = { code: "code", property_type: "property_type", price_value: "price_value", area_value: "area_value" };
/** The reason for an unreadable cell, with what the cell says ("Invalid price: wait price"). */
function quoted(e, cells, lang) {
  const label = pick(ERROR_LABELS[e], lang) || e;
  const v = cells[ERROR_CELL[e]];
  return v === undefined || v === null || String(v).trim() === "" ? label : `${label}: «${String(v).replace(/\s+/g, " ").trim().slice(0, 40)}»`;
}
const ERROR_NEEDS = { code: "code", property_type: "property_type", price_value: "price_value", currency: "price_value", area_value: "area_value" };
const ERROR_LABELS = {
  code: ["كود غير صالح", "Invalid code"],
  property_type: ["نوع الوحدة", "Unit type"],
  price_value: ["سعر غير صحيح", "Invalid price"],
  currency: ["السعر بعملة غير الجنيه (لازم جنيه مصري)", "Price not in EGP (must be Egyptian pounds)"],
  area_value: ["مساحة غير صحيحة", "Invalid area"]
};
const NOTE = {
  compound: (raw, to, lang) => (lang === "en" ? `Compound "${raw}" matched to your existing "${to}"` : `الكمبوند "${raw}" اتربط بـ "${to}" الموجود عندك`),
  phone: (lang) => (lang === "en" ? "Owner phone does not look like a valid number (foreign numbers need the country code)" : "تليفون المالك مش شكل رقم صحيح (الرقم الأجنبي لازم يبدأ بكود الدولة)"),
  dollar: (usd, lang) => (lang === "en" ? `Priced in dollars: saved as $${usd}, not converted` : `السعر بالدولار: اتسجل ${usd}$ من غير تحويل`),
  compoundUnknown: (name, near, lang) => (lang === "en"
    ? `Compound "${name}" is not on the list.${near.length ? ` Did you mean: ${near.join(", ")}?` : ""} Open Edit to pick it from the list, or save it as a new compound.`
    : `الكمبوند "${name}" مش في القائمة.${near.length ? ` قصدك: ${near.join("، ")}؟` : ""} افتح تعديل واختاره من القائمة، أو احفظه ككمبوند جديد.`),
  dupDb: (code, lang) => (lang === "en" ? `Looks like your existing unit ${code}` : `شكلها نفس وحدتك ${code}`),
  dupRow: (row, lang) => (lang === "en" ? `Looks like row ${row} in this sheet` : `شكلها نفس الصف ${row} في الشيت`),
  codeMade: (lang) => (lang === "en" ? "No code in the sheet: numbered in the sheet's own pattern" : "مفيش كود في الشيت: اتعمل بنفس نمط أكواد الشيت"),
  codePattern: (lang) => (lang === "en" ? "Code does not follow the sheet's pattern" : "الكود مش على نمط أكواد الشيت"),
  fromText: (keys, lang) => (lang === "en" ? "Read from text: " : "اتقرا من النص: ") + keys.map((k) => TEXT_LABEL[k][lang === "en" ? 1 : 0]).join(lang === "en" ? ", " : "، ")
};
// Fields the text reader may fill, their words for the note, and cells that never hold free text (a code or phone is its own value).
const TEXT_LABEL = {
  price_value: ["السعر", "price"], area_value: ["المساحة", "area"], property_type: ["النوع", "type"], owner_phone: ["تليفون المالك", "owner phone"],
  bedrooms: ["الغرف", "rooms"], bathrooms: ["الحمامات", "baths"], compound: ["الكمبوند", "compound"], listing_type: ["بيع أو إيجار", "sale or rent"], land_area: ["الأرض", "land"]
};
const TEXT_FIELDS = Object.keys(TEXT_LABEL);
const TEXT_SKIP = ["code", "owner_phone", "unit_no", "floor", "delivery", "bedrooms", "bathrooms", "installment_years"];
// "UPtown cairo" and "UPtown" are the same compound: the city word at the end is not part of the name.
const compoundKey = (v) => normalizeSearch(v).replace(/\s+(cairo|new cairo|القاهره|القاهرة|مصر|egypt)$/, "").trim();

/** Known compounds of the agency by key → the spelling already used. */
async function knownCompounds(pool, agencyId) {
  const { rows } = await pool.query("SELECT compound, COUNT(*) AS n FROM listings WHERE " + Vis.units("listings") + " AND agency_id = $1 AND compound IS NOT NULL GROUP BY compound ORDER BY n DESC", [agencyId]);
  const map = new Map();
  for (const r of rows) if (!map.has(compoundKey(r.compound))) map.set(compoundKey(r.compound), r.compound);
  return map;
}

/**
 * Rows with no code in a tab whose own codes follow a pattern ("NH-9", "VR12") get the next number in that pattern, past
 * the sheet's highest and the agency's highest with the same letters, so a made-up code never lands on an existing unit.
 * Codes in that tab that break the pattern are marked. The marks stay on the stored rows, so later edits keep them.
 */
/** The code prefix comes from the sheet, so it is never used as a pattern or LIKE text as it is (audit 2026-11-06). */
const escapeRegex = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escapeLike = (v) => String(v).replace(/[\\%_]/g, "\\$&");

async function applyCodePatterns(pool, agencyId, sheet) {
  const next = new Map(); // prefix → last number used
  for (const t of sheet.tabs || []) {
    const pat = t.code_pattern;
    if (!pat) continue;
    const rows = sheet.rows.filter((r) => r.tab === t.name);
    const key = pat.prefix;
    if (!next.has(key)) {
      const { rows: have } = await pool.query("SELECT code_norm FROM listings WHERE " + Vis.units("listings") + " AND agency_id = $1 AND code_norm LIKE $2", [agencyId, escapeLike(key) + "%"]);
      const top = have.reduce((m, h) => {
        const x = new RegExp("^" + escapeRegex(key) + "[-_ ]?(\\d+)$", "i").exec(h.code_norm || "");
        return x ? Math.max(m, Number(x[1])) : m;
      }, 0);
      next.set(key, Math.max(top, 0));
    }
    next.set(key, Math.max(next.get(key), pat.max));
    for (const r of rows) {
      const code = String(r.cells.code ?? "").trim();
      if (code) {
        const m = SheetGrid.codeParts(code);
        if (!m || m[1].toUpperCase() !== key) r.code_odd = true;
        continue;
      }
      const n = next.get(key) + 1;
      next.set(key, n);
      r.cells.code = `${key}${pat.sep}${pat.width ? String(n).padStart(pat.width, "0") : n}`;
      r.code_made = true;
    }
  }
}

/* Remembered choices: what an agency picked on a past upload (type words, which of several prices, status words) is applied
   to the next one. Stored in the agency's settings; one button forgets them. */
const PREF_KEYS = ["types", "price_pick", "status_words"];

async function importPrefs(pool, agencyId) {
  const { rows } = await pool.query("SELECT crm_settings->'import_prefs' AS p FROM agencies WHERE id = $1", [agencyId]);
  return rows[0]?.p && typeof rows[0].p === "object" ? rows[0].p : {};
}

async function savePrefs(pool, agencyId, change) {
  const cur = await importPrefs(pool, agencyId);
  const next = { ...cur, ...change, types: { ...(cur.types || {}), ...(change.types || {}) } };
  for (const k of Object.keys(next)) if (!PREF_KEYS.includes(k)) delete next[k];
  await pool.query("UPDATE agencies SET crm_settings = jsonb_set(coalesce(crm_settings, '{}'::jsonb), '{import_prefs}', $2::jsonb) WHERE id = $1", [agencyId, JSON.stringify(next)]);
}

async function forgetPrefs(pool, agencyId) {
  await pool.query("UPDATE agencies SET crm_settings = coalesce(crm_settings, '{}'::jsonb) - 'import_prefs' WHERE id = $1", [agencyId]);
}

/**
 * Plans an Excel import against the agency's inventory (nothing is written).
 * @param {Object} sheet - lib/sheets.js readInventorySheet output
 * @returns {Promise<{ items, counts }>}
 */
async function planExcel(pool, broker, sheet, { lang = "ar", source = null, seenCodes = [] } = {}) {
  let remembered = null;
  if (sheet.tabs) {
    // Earlier choices are only offered on the review page (pre-selected), never applied without a tap.
    remembered = await importPrefs(pool, broker.agency_id);
    await applyCodePatterns(pool, broker.agency_id, sheet);
  }
  // A cell with several prices takes the long-term or monthly one; a price in dollars is kept in dollars (saved with its
  // currency, like a unit added by voice or text); search converts it.
  let places; // the approved places, loaded once and only if a row needs the text reader
  const parsed = [];
  for (const r0 of sheet.rows) {
    let r = r0;
    const draftOf = (cells) => {
      // An installment plan in the price cell is read whole by the importer (not as one of several prices).
      const price = Mixed.installmentOf(cells.price_value) ? { value: cells.price_value, usd: false } : Mixed.cellPrice(cells.price_value);
      return { price, row: SheetImport.rowToDraft(price.value === cells.price_value ? cells : { ...cells, price_value: price.value }) };
    };
    let { price, row } = draftOf(r.cells);
    // A row still missing something may hold it in a text cell (a whole unit in one cell, two columns pasted into one):
    // the chat text reader fills only what the row leaves empty; a value in its own column always wins.
    // Keys filled by an earlier plan are carried on the row, so the "Read from text" note survives a re-plan.
    let fromText = [...(r0.from_text || [])];
    const lacks = row.errors.length || !row.draft.price_value || !row.draft.area_value || !row.draft.property_type;
    // A missing phone alone only sends a cell to the reader when it holds a long digit run (most sheets have no phone column).
    const lacksPhone = !row.draft.details?.owner_phone;
    const texts = lacks || lacksPhone ? Object.entries(r.cells).filter(([k, v]) => !TEXT_SKIP.includes(k) && typeof v === "string" && /\S\s+\S/.test(v) && /\d/.test(v) && (lacks || /[0-9٠-٩]{10,}/.test(v.replace(/[\s-]/g, "")))) : [];
    if (texts.length) {
      if (places === undefined) places = await require("./chatPlan").loadPlaces(pool).catch(() => null);
      const cells = { ...r.cells };
      for (const [, v] of texts) {
        const got = require("../domain/chatListing").parsePost(v, places).cells;
        for (const k of TEXT_FIELDS) {
          // A cell that failed to read for its own field (the price cell holding "4 مليون 150م شقة") may be replaced.
          const own = row.errors.includes(k) && ["price_value", "area_value", "property_type"].includes(k);
          if (got[k] && (SheetImport.isEmpty(cells[k]) || (own && !fromText.includes(k)))) {
            cells[k] = got[k];
            fromText.push(k);
          }
        }
      }
      if (fromText.length) {
        // Written back onto the caller's row so the stored plan (and its Edit window) holds the values the text gave.
        // A field the person clears in Edit can be filled from the text again on the next plan.
        r0.cells = cells;
        r0.from_text = fromText;
        r = r0;
        ({ price, row } = draftOf(cells));
      }
    }
    const usd = price.usd ? price.value : null;
    if (usd && row.draft) row.draft.details = { ...(row.draft.details || {}), currency: "USD" };
    // A cell with several prices: the price the rule did not pick is kept in the description, with the one it picked.
    if (!price.usd && price.value !== r.cells.price_value && row.draft) {
      row.draft.details = { ...(row.draft.details || {}), clean_summary: [row.draft.details?.clean_summary, String(r.cells.price_value).trim()].filter(Boolean).join(" · ") };
    }
    parsed.push({ rowNumber: r.rowNumber, tab: r.tab || null, sheetRow: r.sheetRow || null, ...row, cells: r.cells, fromText, dollar: usd ? { usd } : null, codeMade: Boolean(r.code_made), codeOdd: Boolean(r.code_odd), hint: SheetImport.statusHint(r.cells) });
  }
  const codes = [...new Set(parsed.map((p) => normalizeCode(p.code)).filter(Boolean))];
  const { rows: found } = await pool.query("SELECT * FROM listings WHERE " + Vis.units("listings") + " AND agency_id = $1 AND code_norm = ANY($2::text[])", [broker.agency_id, codes]);
  const byCode = new Map(found.map((l) => [l.code_norm, l]));
  const known = await knownCompounds(pool, broker.agency_id);
  const seen = new Set(seenCodes);
  // One compound resolve per distinct typed name, shared by the unknown-compound check and the duplicate check.
  const CR = require("./compoundResolve");
  const resolved = new Map();
  const resolveOf = async (typed) => {
    if (!resolved.has(typed)) resolved.set(typed, await CR.resolve(pool, { compound: typed }).catch(() => null));
    return resolved.get(typed);
  };
  // Many rows: the agency's comparable units are read once and compared in memory (Store.duplicateIndex); a few rows (one Edit) keep the narrow query.
  let dupIndex = null;
  const findDup = async (l) => {
    if (parsed.length <= 5) return Store.findDuplicate(pool, broker.agency_id, l);
    if (!dupIndex) dupIndex = await Store.duplicateIndex(pool, broker.agency_id);
    const named = Dup.comparable(l) && l.compound && !l.compound_en ? await resolveOf(String(l.compound).trim()) : null;
    return dupIndex.find(l, named);
  };
  const compoundCheck = new Map(); // compound key → { unknown, near } (one lookup per distinct name)
  const items = [];
  const sheetNew = [];
  // Earlier new rows of this sheet, kept by type and bedrooms (what sameUnit checks first): a 3,000-row sheet compared
  // every row with every earlier one took minutes on the small server. Numbers are checked before the text compare.
  const newByKind = new Map();
  const kindKey = (l) => `${l.listing_type || "sale"}|${l.bedrooms ?? -1}`;
  const rememberNew = (item) => {
    sheetNew.push(item);
    const k = kindKey(item.fields || {});
    if (!newByKind.has(k)) newByKind.set(k, []);
    newByKind.get(k).push(item);
  };
  const twinOf = (l) => {
    if (!Dup.comparable(l)) return undefined;
    const a = Number(l.area_value);
    const p = Number(l.price_value);
    const nearBy = (x, y) => Math.abs(x - y) <= y * Dup.TOLERANCE;
    return (newByKind.get(kindKey(l)) || []).find((o) => nearBy(a, Number(o.fields.area_value)) && nearBy(p, Number(o.fields.price_value)) && Dup.sameUnit(l, o.fields));
  };
  // Rows that had text but no known column are shown with their reason, never dropped.
  for (const s of sheet.skipped || []) items.push({ row: s.rowNumber, tab: s.tab || null, sheet_row: s.sheetRow || null, code: null, kind: "invalid", reasons: [lang === "en" ? "No value in a known column" : "مفيش قيمة في عمود معروف"], needs: [], notes: [] });

  for (const p of parsed) {
    const code = normalizeCode(p.code);
    const base = { row: p.rowNumber, tab: p.tab, sheet_row: p.sheetRow, code: code || null, notes: [] };
    if (p.dollar) base.notes.push(NOTE.dollar(p.dollar.usd, lang));
    if (p.codeMade) base.notes.push(NOTE.codeMade(lang));
    if (p.codeOdd) base.notes.push(NOTE.codePattern(lang));
    if (p.fromText.length) base.notes.push(NOTE.fromText(p.fromText, lang));
    if (p.hint) base.status_hint = p.hint;
    if (p.errors.length) {
      items.push({ ...base, kind: "invalid", reasons: p.errors.map((e) => quoted(e, p.cells, lang)), needs: [...new Set(p.errors.map((e) => ERROR_NEEDS[e]).filter(Boolean))] });
      continue;
    }
    // The template's example rows (code SAMPLE-1, notes "صف تجريبي") are never imported as units.
    if (/^SAMPLE[-_ ]/i.test(String(p.cells.code ?? "").trim()) || String(p.cells.notes ?? "").includes("صف تجريبي")) {
      items.push({ ...base, kind: "invalid", reasons: [lang === "en" ? "Sample row, delete it" : "ده صف تجريبي، امسحه"], needs: [], sample: true });
      continue;
    }
    if (p.draft.compound) {
      const canon = known.get(compoundKey(p.draft.compound));
      if (canon && canon !== p.draft.compound) {
        base.notes.push(NOTE.compound(p.draft.compound, canon, lang));
        p.draft.compound = canon;
      }
    }
    const phone = p.draft.details?.owner_phone;
    if (phone && !require("../domain/phone").normalizePhone(phone)) base.notes.push(NOTE.phone(lang));
    if (code && seen.has(code)) {
      items.push({ ...base, kind: "invalid", reasons: [lang === "en" ? "Code repeated in the sheet" : "الكود مكرر في الشيت"], needs: ["code"] });
      continue;
    }
    if (code) seen.add(code);
    const existing = code ? byCode.get(code) : null;
    if (existing) {
      if (!Authz.canEdit(broker, existing)) {
        items.push({ ...base, code: existing.code, kind: "forbidden", reasons: [lang === "en" ? "Another broker's unit" : "وحدة بروكر تاني"] });
        continue;
      }
      const asNew = source === "chat" ? Rules.evaluate(composeRow(null, JSON.parse(JSON.stringify(p.draft)), lang), { lang }) : null;
      const ev = Rules.evaluate(composeRow(existing, dropEchoes(existing, p.draft), lang), { lang });
      if (!ev.ok) {
        items.push({ ...base, code: existing.code, kind: "invalid", reasons: ev.blockers.map((b) => reasonOf(b, lang)), needs: needsOf(ev.blockers) });
        continue;
      }
      const patch = Edits.diffPatch(existing, ev.listing);
      // A code written in a chat post that belongs to a different unit of the agency: the person chooses (merge or a new code).
      if (asNew?.ok && !Dup.sameUnit(asNew.listing, existing)) {
        items.push({
          ...base,
          code: existing.code,
          kind: "review",
          code_taken: true,
          fields: asNew.listing,
          warnings: asNew.warnings.map((w) => Rules.warningLine(w, lang)),
          existing_line: stripLine(Describe.compactLine({ ...existing }, lang)),
          merge: { listing_id: existing.id, version: existing.version, code: existing.code, patch, before: Object.fromEntries(Object.keys(patch).map((k) => [k, existing[k] === undefined ? null : existing[k]])), changes: describeChanges(existing, patch, lang) }
        });
        continue;
      }
      if (p.status && p.status !== existing.status) patch.status = p.status;
      const before = Object.fromEntries(Object.keys(patch).map((k) => [k, existing[k] === undefined ? null : existing[k]]));
      // A chat post always carries generated text ("WhatsApp · sender · date" notes, its own text as the description): those alone never
      // make an existing unit "changed". The owner phone is only ever read from the post's own text (never the sender's chat phone),
      // so it stays a real change.
      const AUTO = new Set(["details.notes", "details.clean_summary", "details.summary_en"]);
      const changes = describeChanges(existing, patch, lang).filter((c) => source !== "chat" || !AUTO.has(c.field));
      items.push({
        ...base,
        code: existing.code,
        // Only what the broker can see counts; normalization the row did not ask for (e.g. a villa's
        // stored BUA) is not a change.
        kind: changes.length ? "changed" : "unchanged",
        listing_id: existing.id,
        version: existing.version,
        patch,
        before,
        changes
      });
    } else {
      const ev = Rules.evaluate(composeRow(null, p.draft, lang), { lang });
      if (!ev.ok) {
        items.push({ ...base, kind: "invalid", reasons: ev.blockers.map((b) => reasonOf(b, lang)), needs: needsOf(ev.blockers) });
        continue;
      }
      // A new unit needs a valid owner phone (every unit needs an owner contact), whatever the source: held for the Edit window,
      // and said here, so the preview and the apply agree (QA 2026-11-17: a bad phone was listed as New, then not applied).
      const ownerPhone = p.draft.details?.owner_phone;
      const typedPhone = String(ownerPhone ?? p.cells?.owner_phone ?? "").trim();
      // A typed number that is not a mobile is a problem, and so is an empty one: createListing refuses a unit with no owner phone.
      if (!require("../domain/phone").normalizePhone(ownerPhone)) {
        const typed = typedPhone;
        const reason = typed
          ? lang === "en" ? `Owner phone is not a valid Egyptian mobile: «${typed.slice(0, 40)}»` : `تليفون المالك مش موبايل مصري صحيح: «${typed.slice(0, 40)}»`
          : lang === "en" ? "Owner phone is required" : "تليفون المالك مطلوب";
        items.push({ ...base, kind: "invalid", reasons: [reason], needs: ["owner_phone"] });
        continue;
      }
      if (p.status && p.status !== "active") ev.listing.status = p.status;
      const warnings = ev.warnings.map((w) => Rules.warningLine(w, lang));
      // A compound that is not on the approved list is a warning, never a block: the person can open Edit and pick it from the
      // list (suggestions, chips), or save it as a new compound. The add form asks the same question.
      let unknownCompound = false;
      const typedCompound = String(ev.listing.compound || "").trim();
      if (typedCompound) {
        const key = compoundKey(typedCompound);
        if (!compoundCheck.has(key)) {
          const r = await resolveOf(typedCompound);
          const unknown = Boolean(r && r.compound_state === "needs_fix");
          compoundCheck.set(key, { unknown, near: unknown ? ((await CR.suggest(pool, typedCompound, 3).catch(() => [])) || []).map((x) => (typeof x === "string" ? x : x.name || x.name_ar || "")).filter(Boolean) : [] });
        }
        const c = compoundCheck.get(key);
        if (c.unknown) {
          unknownCompound = true;
          warnings.push(NOTE.compoundUnknown(typedCompound, c.near, lang));
        }
      }
      // A likely duplicate: an active unit in the agency, or an earlier row of this sheet (never a block, only a warning).
      const dup = await findDup(ev.listing);
      if (dup) warnings.push(NOTE.dupDb(dup, lang));
      if (dup && source === "chat") {
        const ex = await Store.findByCode(pool, broker.agency_id, dup);
        const evMerge = ex && Authz.canEdit(broker, ex) ? Rules.evaluate(composeRow(ex, dropEchoes(ex, JSON.parse(JSON.stringify(p.draft))), lang), { lang }) : null;
        if (evMerge?.ok) {
          const patchM = Edits.diffPatch(ex, evMerge.listing);
          const item = {
            ...base,
            kind: "review",
            dup_code: ex.code,
            fields: ev.listing,
            warnings,
            existing_line: stripLine(Describe.compactLine({ ...ex }, lang)),
            merge: { listing_id: ex.id, version: ex.version, code: ex.code, patch: patchM, before: Object.fromEntries(Object.keys(patchM).map((k) => [k, ex[k] === undefined ? null : ex[k]])), changes: describeChanges(ex, patchM, lang) }
          };
          rememberNew(item);
          items.push(item);
          continue;
        }
      }
      if (!dup) {
        const twin = twinOf(ev.listing);
        if (twin) warnings.push(NOTE.dupRow(twin.row, lang));
      }
      const item = { ...base, kind: "new", fields: ev.listing, warnings, ...(unknownCompound ? { unknown_compound: true } : {}) };
      rememberNew(item);
      items.push(item);
    }
  }

  const counts = items.reduce((acc, i) => ({ ...acc, [i.kind]: (acc[i.kind] || 0) + 1 }), {});
  // Whether the sheet had an owner phone column at all (the review says so when it had none).
  const mapped = Array.isArray(sheet.mapped) ? sheet.mapped : null;
  const info = source === "chat" ? null : { no_phone_column: mapped ? !mapped.includes("owner_phone") : !sheet.rows.some((r) => r.cells?.owner_phone !== undefined) };
  return { items, counts, ...(info ? { info } : {}), ...(remembered ? { remembered } : {}) };
}

/**
 * The cells a unit cannot be saved without, by the SAME rules as the add and edit unit forms: the field rules' blockers
 * (sale or rent, type, place, price, area, bedrooms for an apartment or a villa, …) and an owner phone (createListing).
 * Used by the WhatsApp import's preview, review cards and Edit window, so they never disagree with the unit form.
 * @returns {string[]} cell keys (listing_type, property_type, compound, price_value, area_value, bedrooms, owner_phone, …)
 */
function readCells(cells = {}) {
  const price = Mixed.installmentOf(cells.price_value) ? { value: cells.price_value, usd: false } : Mixed.cellPrice(cells.price_value);
  const row = SheetImport.rowToDraft(price.value === cells.price_value ? cells : { ...cells, price_value: price.value });
  if (price.usd && row.draft) row.draft.details = { ...(row.draft.details || {}), currency: "USD" };
  return row;
}

/** A unit's listing fields from a post's cells, the way the import plan composes them (the app turns them into its form). */
function fieldsOfCells(cells = {}, lang = "ar") {
  const row = readCells(cells);
  return composeRow(null, JSON.parse(JSON.stringify(row.draft || {})), lang);
}

function missingCells(cells = {}, lang = "ar") {
  const row = readCells(cells);
  const out = new Set(row.errors.map((e) => ERROR_NEEDS[e]).filter(Boolean));
  if (!row.errors.length || row.draft) {
    const ev = Rules.evaluate(composeRow(null, JSON.parse(JSON.stringify(row.draft || {})), lang), { lang });
    for (const k of needsOf(ev.blockers || [])) out.add(k);
  }
  if (!require("../domain/phone").normalizePhone(row.draft?.details?.owner_phone ?? cells.owner_phone)) out.add("owner_phone");
  return [...out];
}

/** Saves a plan; returns its id. */
async function savePlan(pool, broker, kind, payload, { filename = null, status = "ready" } = {}) {
  const { rows } = await pool.query(
    "INSERT INTO web_imports (agency_id, broker_id, kind, status, filename, payload) VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id",
    [broker.agency_id, broker.id, kind, status, filename, JSON.stringify(payload)]
  );
  return rows[0].id;
}

async function loadImport(pool, broker, id) {
  if (!/^[0-9a-f-]{36}$/.test(String(id))) return null;
  const { rows } = await pool.query("SELECT *, xmin::text AS row_version FROM web_imports WHERE id = $1 AND agency_id = $2 AND broker_id = $3", [id, broker.agency_id, broker.id]);
  return rows[0] || null;
}

/** Claims a ready plan once (a second apply, a stale tab or an expired plan gets null). */
async function claim(pool, broker, id, kind) {
  const { rows } = await pool.query(
    `UPDATE web_imports SET status = 'applied', applied_at = NOW()
     WHERE id = $1 AND agency_id = $2 AND broker_id = $3 AND kind = $4 AND status = 'ready' AND expires_at > NOW()
     RETURNING *`,
    [id, broker.agency_id, broker.id, kind]
  );
  return rows[0] || null;
}

async function insertOne(pool, broker, fields, code, lang, batch = null) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // A file has no one to ask: a row with an owner phone and no name uses the phone as the name.
    if (fields.details?.owner_phone && !fields.details.owner_name) fields.details.owner_name = require("../domain/phone").displayPhone(fields.details.owner_phone);
    const res = await Store.createListing(client, broker, { fields, code, lang, batch });
    if (res.listing && fields.status && fields.status !== "active") {
      await client.query("UPDATE listings SET status = $1 WHERE id = $2 AND agency_id = $3", [fields.status, res.listing.id, broker.agency_id]);
    }
    await client.query(res.listing ? "COMMIT" : "ROLLBACK");
    return res;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** One patch with the version seen at planning time. */
async function patchOne(pool, broker, code, patch, expectedVersion) {
  return Edits.withCodeLock(pool, broker.agency_id, code, async (client) => {
    const listing = await Store.findByCode(client, broker.agency_id, code, { forUpdate: true });
    if (!listing) return { rollback: true, outcome: "missing" };
    if (!Authz.canEdit(broker, listing)) return { rollback: true, outcome: "forbidden" };
    const res = await Store.applyListingPatch(client, broker, { listing, patch, expectedVersion: expectedVersion ?? listing.version });
    if (res.conflict) return { rollback: true, outcome: "conflict" };
    if (!res.listing) return { rollback: true, outcome: "forbidden" };
    return { outcome: "updated", listing: res.listing };
  });
}

/* ---------------------------------------------------------------------- */
/* Apply: a background job, a few rows at a time, written down as it goes   */
/* ---------------------------------------------------------------------- */

const applyJobs = new Map(); // import id → promise of the running Apply (tests and shutdown can wait for it)
const APPLY_BATCH = 25; // rows per transaction, and how often the result is written (a crash leaves a record)
const APPLY_STALE_MS = 120000; // an 'applying' plan with no heartbeat for this long lost its process

const rowSet = (v) => new Set((Array.isArray(v) ? v : []).map(Number));
/** Rows of a plan an Apply already wrote (the plan stays 'ready' while other rows remain). */
const appliedRows = (imp) => new Set([...rowSet(imp?.payload?.applied_rows), ...rowSet(imp?.result?.applied_rows)]);
/** The new and changed rows no Apply wrote yet (a thrown-away row does not count). The plan closes when there are none. */
function remainingRows(imp) {
  const done = appliedRows(imp);
  const thrown = rowSet(imp?.payload?.discarded);
  return (imp?.payload?.items || []).filter((i) => ["new", "changed"].includes(i.kind) && !done.has(i.row) && !thrown.has(i.row)).map((i) => i.row);
}

const FAIL_REASONS = {
  owner_required: ["تليفون المالك ناقص أو مش صحيح", "Owner phone is missing or not valid"],
  owner_name_required: ["اسم المالك ناقص", "Owner name is missing"],
  forbidden: ["مش من حقك تضيف أو تعدل وحدات", "You may not add or change units"],
  missing: ["الوحدة مش موجودة", "The unit no longer exists"],
  photos: ["الصور متحفظتش", "The photos were not saved"],
  error: ["حصلت مشكلة وقت الحفظ", "Something went wrong while saving"]
};
/** The words for a failed row's reason key (an unknown key is shown as it is). */
const failReason = (reason, lang = "ar") => pick(FAIL_REASONS[reason], lang) || String(reason || "");
/** A failed entry as a line: "NH-1: reason". Old results stored the code alone (a string). */
const failedLine = (f, lang = "ar") => (f && typeof f === "object" ? (f.reason ? `${f.code}: ${failReason(f.reason, lang)}` : String(f.code)) : String(f));
const failedCode = (f) => (f && typeof f === "object" ? f.code : f);

/** Moves a ready plan to 'applying' once (a second press, a stale tab or an expired plan gets null). */
async function claimApply(pool, broker, id, req) {
  const { rows } = await pool.query(
    `UPDATE web_imports SET status = 'applying', applied_at = NOW(), result = coalesce(result, '{}'::jsonb) || $4::jsonb
     WHERE id = $1 AND agency_id = $2 AND broker_id = $3 AND kind = 'excel' AND status = 'ready' AND expires_at > NOW()
     RETURNING *`,
    [id, broker.agency_id, broker.id, JSON.stringify({ apply_req: req, heartbeat: new Date().toISOString(), progress: { done: 0, total: 0 } })]
  );
  return rows[0] || null;
}

function launchApply(pool, broker, imp, req, fresh) {
  const run = new Promise((resolve) => setImmediate(resolve)).then(() => runApply(pool, broker, imp, req, fresh));
  // Kept apart so a failure in the background is logged (the plan stays 'applying': Resume or Undo), never an unhandled rejection.
  run.catch((err) => console.error("Excel apply failed:", err.message)).finally(() => applyJobs.delete(imp.id));
  applyJobs.set(imp.id, run);
  return run;
}

/**
 * Starts applying the ticked rows in the background and returns at once: { id, status: "applying" }, or null when the plan
 * cannot be applied (not ready, already running, expired, not this broker's). Poll applyStatus.
 */
async function startApplyExcel(pool, broker, id, { rows = [], lang = "ar", resolutions = {}, photoChoices = {} } = {}) {
  const req = { rows: [...new Set(rows.map(Number))].filter(Number.isInteger), lang, resolutions, photoChoices };
  const imp = await claimApply(pool, broker, id, req);
  if (!imp) return null;
  launchApply(pool, broker, imp, req, true);
  return { id, status: "applying" };
}

/** Applies the ticked rows and waits for the end (what the page did before Apply ran in the background). Null when the plan cannot be applied. */
async function applyExcel(pool, broker, id, opts = {}) {
  const started = await startApplyExcel(pool, broker, id, opts);
  if (!started) return null;
  return applyJobs.get(id);
}

/**
 * Where an Apply is: { status, done, total, created, updated, failed, resumed }. An 'applying' plan whose process died (no
 * running job here, no heartbeat for a while) is taken up again from the rows it already wrote.
 */
async function applyStatus(pool, broker, id, { staleMs = APPLY_STALE_MS } = {}) {
  let imp = await loadImport(pool, broker, id);
  if (!imp || imp.kind !== "excel") return null;
  let resumed = false;
  if (imp.status === "applying" && !applyJobs.has(id) && imp.result?.apply_req) {
    const { rows } = await pool.query(
      `UPDATE web_imports SET result = jsonb_set(result, '{heartbeat}', to_jsonb(now()::text))
       WHERE id = $1 AND status = 'applying' AND (result->>'heartbeat')::timestamptz < now() - ($2::int * interval '1 millisecond') RETURNING *`,
      [id, staleMs]
    );
    if (rows[0]) {
      launchApply(pool, broker, rows[0], rows[0].result.apply_req, false);
      resumed = true;
      imp = rows[0];
    }
  }
  const r = imp.result || {};
  return {
    status: imp.status,
    done: r.progress?.done || 0,
    total: r.progress?.total || 0,
    created: (r.created || []).length,
    updated: (r.updated || []).length,
    failed: (r.failed || []).length,
    remaining: imp.status === "ready" ? remainingRows(imp).length : 0,
    resumed
  };
}

/** Waits for a running Apply of this plan (immediately when none). */
const waitForApply = (id) => applyJobs.get(id) || Promise.resolve();

async function runApply(pool, broker, imp, req, fresh) {
  const id = imp.id;
  const lang = req.lang || "ar";
  const resolutions = req.resolutions || {};
  const photoChoices = req.photoChoices || {};
  const payload = imp.payload;
  const chat = payload.source === "chat";
  const started = Date.now();
  const prev = imp.result || {};
  // unchanged: an existing unit the post says nothing new about (never written, never given photos); blocked: a row with errors or one
  // the person may not change; discarded: rows the person threw away in the review. None of these is written, even when ticked.
  // What was written (created, updated, undo, applied_rows) adds up over the Applys of a plan; the other lists are the last one's.
  const keep = (k) => (fresh ? [] : [...(prev[k] || [])]);
  const result = {
    created: [...(prev.created || [])],
    updated: [...(prev.updated || [])],
    conflicts: keep("conflicts"),
    failed: keep("failed"),
    unchanged: keep("unchanged"),
    blocked: keep("blocked"),
    discarded: keep("discarded"),
    limit_skipped: keep("limit_skipped"),
    undo: { made: [...(prev.undo?.made || [])], changed: [...(prev.undo?.changed || [])], photos: [...(prev.undo?.photos || [])] },
    applied_rows: [...(prev.applied_rows || [])]
  };
  if (prev.photos) result.photos = prev.photos;
  if (!fresh && prev.limit) result.limit = prev.limit;
  const done = new Set(result.applied_rows.map(Number));
  const wanted = new Set((req.rows || []).map(Number));
  const thrown = rowSet(payload.discarded);
  const savedRows = new Set();
  const photoMap = payload.photos || {};
  const used = new Set();
  const label = (item) => item.code || `row ${item.row}`;
  const markDone = (row) => {
    if (!done.has(row)) {
      done.add(row);
      result.applied_rows.push(row);
    }
  };

  const queue = (payload.items || []).filter((i) => wanted.has(i.row) && !done.has(i.row));
  const steps = queue.map((item) => {
    if (thrown.has(item.row)) return { item, type: "discarded" };
    if (item.kind === "unchanged") return { item, type: "unchanged" };
    if (item.kind === "invalid" || item.kind === "forbidden") return { item, type: "blocked" };
    if (item.kind === "new") return { item, type: "insert", code: item.code };
    if (item.kind === "changed") return { item, type: "merge" };
    if (item.kind === "review") {
      const pick = resolutions[item.row] || {};
      if (pick.mode === "merge" && item.merge && !(item.merge.changes || []).length) return { item, type: "unchanged", code: item.merge.code || item.code };
      if (pick.mode === "merge" && item.merge) return { item, type: "merge" };
      // A new unit: the code typed in the review, else the message's own code when it is free, else a generated one.
      const typed = pick.code ? normalizeCode(pick.code) : null;
      return { item, type: "insert", code: typed || (item.code_taken ? null : item.code || null) };
    }
    return { item, type: "skip" };
  });

  let processed = 0;
  let sinceWrite = 0;
  const writeResult = async (db) => {
    result.heartbeat = new Date().toISOString();
    result.progress = { done: processed, total: steps.length };
    result.apply_req = req;
    await db.query("UPDATE web_imports SET result = $2::jsonb WHERE id = $1", [id, JSON.stringify(result)]);
    sinceWrite = 0;
  };

  const withPhotos = async (item, listing) => {
    if (!listing) return;
    const list = photoMap[String(item.row)] || [];
    try {
      const urls = await attachChatPhotos(pool, broker, listing, list, photoChoices[item.row] || {}, result);
      urls.forEach((u) => used.add(u));
      result.photos = (result.photos || 0) + urls.length;
    } catch (err) {
      result.failed.push({ code: listing.code, reason: "photos" });
      console.warn("Chat import photos failed:", err.message);
    }
  };
  const merge = async (item) => {
    const res = await patchOne(pool, broker, item.merge?.code || item.code, item.merge?.patch || item.patch, item.merge?.version ?? item.version);
    if (res.outcome === "updated") {
      markDone(item.row);
      savedRows.add(item.row);
      result.updated.push(res.listing.code);
      result.undo.changed.push({ code: res.listing.code, before: item.merge?.before || item.before || {}, version: res.listing.version });
      await withPhotos(item, res.listing);
    } else if (res.outcome === "conflict") result.conflicts.push(item.merge?.code || item.code);
    else result.failed.push({ code: item.merge?.code || item.code, reason: res.outcome === "forbidden" ? "forbidden" : "missing" });
  };

  let shared = null;
  /**
   * One transaction for up to APPLY_BATCH consecutive new units; a SAVEPOINT per row, so a bad row never rolls back the others.
   * The result (with the undo log) is written in the same transaction: a crash leaves either all of these rows and their record, or none.
   * @returns {Promise<number>} how many of the chunk's steps were handled (fewer when the unit limit stopped it)
   */
  const insertChunk = async (chunk) => {
    shared = shared || (await Store.batchContext(pool, broker));
    const client = await pool.connect();
    const made = [];
    let handled = 0;
    try {
      await client.query("BEGIN");
      shared.codes = Store.codeSequence(client, broker.agency_id);
      for (const s of chunk) {
        const { item } = s;
        const fields = item.fields;
        // A file has no one to ask: a row with an owner phone and no name uses the phone as the name.
        if (fields?.details?.owner_phone && !fields.details.owner_name) fields.details.owner_name = require("../domain/phone").displayPhone(fields.details.owner_phone);
        const left = shared.left;
        const usedCount = shared.used;
        await client.query("SAVEPOINT apply_row");
        let res;
        try {
          res = await Store.createListing(client, broker, { fields, code: s.code, lang, batch: `import:${id}`, shared });
          if (res.listing && fields.status && fields.status !== "active") {
            await client.query("UPDATE listings SET status = $1 WHERE id = $2 AND agency_id = $3", [fields.status, res.listing.id, broker.agency_id]);
          }
          await client.query(res.listing ? "RELEASE SAVEPOINT apply_row" : "ROLLBACK TO SAVEPOINT apply_row");
          if (!res.listing) await client.query("RELEASE SAVEPOINT apply_row");
        } catch (err) {
          await client.query("ROLLBACK TO SAVEPOINT apply_row");
          await client.query("RELEASE SAVEPOINT apply_row");
          shared.left = left;
          shared.used = usedCount;
          console.warn("Excel apply row failed:", err.message);
          result.failed.push({ code: label(item), reason: "error" });
          handled++;
          processed++;
          continue;
        }
        handled++;
        processed++;
        if (res.listing) {
          markDone(item.row);
          savedRows.add(item.row);
          result.created.push(res.listing.code);
          result.undo.made.push({ id: res.listing.id, code: res.listing.code, version: res.listing.version });
          made.push(s);
          made[made.length - 1].listing = res.listing;
        } else if (res.limit) {
          result.limit = res.limit;
          handled--;
          processed--;
          break;
        } else if (res.owner_required || res.owner_name_required) result.failed.push({ code: label(item), reason: res.owner_required ? "owner_required" : "owner_name_required" });
        else if (res.forbidden) result.failed.push({ code: label(item), reason: "forbidden" });
        else result.conflicts.push(res.code);
      }
      await shared.codes.finish();
      // A chat plan is small and its rows carry photos: its record is written every APPLY_BATCH rows instead.
      if (!chat) await writeResult(client);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    if (chat) sinceWrite += handled;
    for (const s of made) {
      const np = (payload.newPlaces || {})[String(s.item.row)];
      if (np && s.item.fields?.compound) await require("../lib/placeNames").addDetails(pool, s.item.fields.compound, np).catch(() => {});
      await withPhotos(s.item, s.listing);
    }
    return handled;
  };

  let k = 0;
  while (k < steps.length) {
    const s = steps[k];
    if (s.type === "insert") {
      const size = chat ? 1 : APPLY_BATCH;
      const chunk = [];
      for (let j = k; j < steps.length && steps[j].type === "insert" && chunk.length < size; j++) chunk.push(steps[j]);
      const handled = await insertChunk(chunk);
      k += handled;
      if (handled < chunk.length) {
        // The plan's unit limit stopped the run: every other ticked row that was still to be written is listed, not lost.
        for (const rest of steps.slice(k)) if (rest.type === "insert" || rest.type === "merge") result.limit_skipped.push(label(rest.item));
        break;
      }
    } else {
      if (s.type === "discarded") result.discarded.push(label(s.item));
      else if (s.type === "unchanged") result.unchanged.push(s.code || label(s.item));
      else if (s.type === "blocked") result.blocked.push(label(s.item));
      else if (s.type === "merge") await merge(s.item);
      processed++;
      k++;
      sinceWrite++;
    }
    if (sinceWrite >= APPLY_BATCH) await writeResult(pool);
  }
  if (!fresh) for (const key of ["conflicts", "unchanged", "blocked", "discarded", "limit_skipped"]) result[key] = [...new Set(result[key])];
  const unused = Object.values(photoMap).flat().map((x) => x?.url).filter((u) => u && !used.has(u));
  if (unused.length) await Supabase.deleteStorageFiles(unused).catch(() => {});
  result.applied_rows.sort((a, b) => a - b);
  result.progress = { done: steps.length, total: steps.length };
  result.heartbeat = new Date().toISOString();
  // The plan stays open while new or changed rows are left (the next page, a fixed row); a chat plan is closed by its first Apply.
  const left = chat ? [] : remainingRows({ payload, result });
  await pool.query(
    "UPDATE web_imports SET result = $2::jsonb, status = $3, payload = jsonb_set(payload, '{applied_rows}', $4::jsonb, true) WHERE id = $1 AND status = 'applying'",
    [id, JSON.stringify(result), left.length ? "ready" : "applied", JSON.stringify(result.applied_rows)]
  );
  if (chat) {
    ParseLog.applied(pool, broker, id, payload, wanted, Date.now() - started);
    // Remembered for the next import of this chat (website and app): what was saved, and what the chat said nothing new about.
    const unchanged = payload.items.filter((i) => i.kind === "unchanged" && !thrown.has(i.row)).map((i) => i.row);
    await rememberRows(pool, broker, payload, [...[...savedRows].map((r) => [r, "saved"]), ...unchanged.filter((r) => !savedRows.has(r)).map((r) => [r, "unchanged"])]);
  }
  return result;
}

/** Writes the outcome of chat plan rows ([[row, outcome]]) to the agency's remembered decisions, by the posts' fingerprints. Never breaks an import. */
async function rememberRows(pool, broker, payload, pairs) {
  if (!payload?.chat_fp || !pairs.length) return;
  const items = pairs.map(([row, outcome]) => ({ post_fp: payload.posts?.[row - 1]?.pfp, outcome })).filter((x) => x.post_fp);
  for (let i = 0; i < items.length; i += Decisions.MAX_PER_REQUEST) await Decisions.record(pool, broker.agency_id, broker.id, payload.chat_fp, items.slice(i, i + Decisions.MAX_PER_REQUEST)).catch(() => {});
}

/**
 * Photos of a chat post onto a unit. choice.keep: indexes of the uploaded photos to keep (default all), choice.drop: ids
 * of the unit's existing photos to remove. The unit never goes over 15 photos; a picture the unit already has is skipped.
 * What was added and removed is written to result.undo so the import can be undone.
 */
async function attachChatPhotos(pool, broker, listing, photos, choice, result) {
  const dropIds = Array.isArray(choice.drop) ? choice.drop : [];
  if (!photos.length && !dropIds.length) return [];
  const { rows: have } = await pool.query("SELECT id, url, position, role, phash::text AS phash FROM listing_images WHERE listing_id = $1 AND agency_id = $2 ORDER BY position, id", [listing.id, broker.agency_id]);
  const dropped = have.filter((h) => dropIds.includes(h.id));
  const left = have.filter((h) => !dropIds.includes(h.id));
  const keep = Array.isArray(choice.keep) ? choice.keep : photos.map((_, i) => i);
  const chosen = [];
  for (const i of keep) {
    const ph = photos[Number(i)];
    if (!ph?.url || left.length + chosen.length >= MAX_PHOTOS) continue;
    const dup = ph.hash && [...left.map((h) => h.phash), ...chosen.map((c) => c.hash)].some((x) => x && PhotoHash.distance(x, ph.hash) <= PhotoHash.MAX_DISTANCE);
    if (!dup) chosen.push(ph);
  }
  if (dropped.length) await Store.removePhotos(pool, listing, dropped.map((d) => d.id));
  if (chosen.length) {
    await Store.addPhotos(pool, listing, chosen.map((c) => c.url));
    await PhotoHash.saveHashes(pool, broker.agency_id, new Map(chosen.map((c) => [c.url, c.hash])));
  }
  result.undo.photos.push({ id: listing.id, code: listing.code, added: chosen.map((c) => c.url), dropped: dropped.map((d) => ({ url: d.url, position: d.position, role: d.role, phash: d.phash })) });
  return chosen.map((c) => c.url);
}

/* Undo: only the agency's last applied Excel import. Units it added are deleted like any unit (10 days in Recently deleted, then gone; they stop counting against the plan at once); units it changed get the
   values they had before. A unit edited since the import is skipped and listed, never overwritten. */

/** The agency's last applied Excel import that was not undone yet; null when there is none. */
async function lastApplied(pool, agencyId) {
  const { rows } = await pool.query(
    `SELECT * FROM web_imports WHERE agency_id = $1 AND kind = 'excel' AND result IS NOT NULL
       AND (status = 'applied' OR (status IN ('ready', 'applying')
            AND jsonb_array_length(coalesce(result#>'{undo,made}', '[]'::jsonb)) + jsonb_array_length(coalesce(result#>'{undo,changed}', '[]'::jsonb)) > 0))
     ORDER BY applied_at DESC LIMIT 1`,
    [agencyId]
  );
  const imp = rows[0] || null;
  return imp && imp.result?.undo && !imp.result.undone ? imp : null;
}

/** What undoing this import would do, without changing anything. */
async function undoPreview(pool, agencyId, imp) {
  const log = imp.result?.undo || { made: [], changed: [] };
  const archive = [];
  const restore = [];
  const skipped = [];
  for (const m of log.made) {
    const { rows } = await pool.query("SELECT version, status FROM listings WHERE " + Vis.units("listings") + " AND id = $1 AND agency_id = $2", [m.id, agencyId]);
    if (rows[0] && Number(rows[0].version) === Number(m.version) && rows[0].status !== "deleted") archive.push(m);
    else skipped.push(m.code);
  }
  for (const c of log.changed) {
    const { rows } = await pool.query("SELECT version FROM listings WHERE " + Vis.units("listings") + " AND code_norm = $1 AND agency_id = $2", [normalizeCode(c.code), agencyId]);
    if (rows[0] && Number(rows[0].version) === Number(c.version)) restore.push(c);
    else skipped.push(c.code);
  }
  return { archive, restore, skipped };
}

/** Whether this broker may undo this import now (the last applied one, not yet undone). A plan still open for more rows, or one whose Apply was cut short, can be undone for what it wrote. */
async function canUndo(pool, broker, imp) {
  if (!imp || imp.kind !== "excel" || !["applied", "ready", "applying"].includes(imp.status)) return false;
  if (imp.status === "applying" && (applyJobs.has(imp.id) || Date.now() - Date.parse(imp.result?.heartbeat || 0) < APPLY_STALE_MS)) return false;
  const last = await lastApplied(pool, broker.agency_id);
  return Boolean(last && last.id === imp.id);
}

/** Undoes the last applied Excel import. Claims it first, so a double press does nothing the second time. */
async function undoExcel(pool, broker, id) {
  const imp = await loadImport(pool, broker, id);
  if (!(await canUndo(pool, broker, imp))) return null;
  const { rows: claimed } = await pool.query(
    "UPDATE web_imports SET status = 'applied', result = jsonb_set(result, '{undone}', $3::jsonb) WHERE id = $1 AND agency_id = $2 AND status IN ('applied', 'ready', 'applying') AND NOT (result ? 'undone') RETURNING id",
    [id, broker.agency_id, JSON.stringify({ at: new Date().toISOString(), by: broker.id })]
  );
  if (!claimed[0]) return null;
  const plan = await undoPreview(pool, broker.agency_id, imp);
  const out = { archived: [], restored: [], skipped: [...plan.skipped] };
  for (const m of plan.archive) {
    const { rowCount } = await pool.query(
      "UPDATE listings SET status = 'deleted', deleted_at = now(), deleted_by = $4, version = version + 1, updated_at = now() WHERE id = $1 AND agency_id = $2 AND version = $3",
      [m.id, broker.agency_id, m.version, broker.id]
    );
    if (rowCount) out.archived.push(m.code);
    else out.skipped.push(m.code);
  }
  for (const c of plan.restore) {
    const res = await patchOne(pool, broker, c.code, c.before, c.version);
    if (res.outcome === "updated") out.restored.push(c.code);
    else out.skipped.push(c.code);
  }
  // Photos the import added are taken off again; photos it removed from a merged unit are put back.
  for (const ph of imp.result?.undo?.photos || []) {
    try {
      if (ph.added?.length) await pool.query("DELETE FROM listing_images WHERE listing_id = $1 AND agency_id = $2 AND url = ANY($3::text[])", [ph.id, broker.agency_id, ph.added]);
      for (const d of ph.dropped || []) {
        await pool.query("INSERT INTO listing_images (listing_id, agency_id, position, url, role, phash) VALUES ($1, $2, $3, $4, $5, $6::bit(64))", [ph.id, broker.agency_id, d.position, d.url, d.role || null, d.phash || null]);
      }
    } catch (err) {
      out.skipped.push(`${ph.code} (photos)`);
    }
  }
  await pool.query("UPDATE web_imports SET result = jsonb_set(result, '{undone}', $2::jsonb) WHERE id = $1", [id, JSON.stringify({ at: new Date().toISOString(), by: broker.id, archived: out.archived, restored: out.restored, skipped: out.skipped })]);
  return out;
}

const MAX_CELL = 600;
const EDITABLE = new Set(SheetImport.COLUMNS.map(([k]) => k));
const countKinds = (items) => items.reduce((acc, i) => ({ ...acc, [i.kind]: (acc[i.kind] || 0) + 1 }), {});

/**
 * Edits one row of a ready Excel plan and plans just that row again from the edited cells, so it goes through the same
 * parsing and rules as an upload. Any known column can be edited (a missing "sale or rent" included).
 * @param {Object} cells - field key → new text
 * @returns {Promise<boolean>} false when the plan is not ready, expired, has no stored sheet or the row is unknown
 */
async function editExcelRow(pool, broker, id, rowNumber, cells, { lang = "ar" } = {}) {
  const imp = await loadImport(pool, broker, id);
  if (!imp || imp.kind !== "excel" || imp.status !== "ready" || new Date(imp.expires_at) <= new Date()) return false;
  const { rows, items } = imp.payload;
  const target = Array.isArray(rows) ? rows.find((r) => r.rowNumber === Number(rowNumber)) : null;
  // A row an Apply already wrote is not planned again.
  if (appliedRows(imp).has(Number(rowNumber))) return false;
  const at = Array.isArray(items) ? items.findIndex((i) => i.row === Number(rowNumber)) : -1;
  if (!target || at < 0) return false;
  const oldType = target.cells.property_type;
  for (const [key, v] of Object.entries(cells || {})) {
    if (!EDITABLE.has(key)) continue;
    if (key === "code") {
      delete target.code_made;
      delete target.code_odd;
    }
    const value = String(v ?? "").slice(0, MAX_CELL).trim();
    // A value the person changed is theirs now, no longer "read from text".
    if (target.from_text && String(target.cells[key] ?? "") !== value) target.from_text = target.from_text.filter((k) => k !== key);
    if (value) target.cells[key] = value;
    else delete target.cells[key];
  }
  // A type word the app did not know, fixed by hand in the review, is learned for the next upload.
  const newType = SheetImport.propertyType(target.cells.property_type);
  if (typeKey(oldType) && !SheetImport.propertyType(oldType) && newType) await savePrefs(pool, broker.agency_id, { types: { [typeKey(oldType)]: newType } });
  const oldCode = items[at].code;
  const plan = (rowsToPlan) => planExcel(pool, broker, { rows: rowsToPlan }, { lang, source: imp.payload.source || null });
  const markRepeat = (item) => {
    if (item.code && ["new", "changed"].includes(item.kind) && items.some((i) => i.row !== item.row && i.code === item.code && ["new", "changed"].includes(i.kind))) {
      Object.assign(item, { kind: "invalid", reasons: [lang === "en" ? "Code repeated in the sheet" : "الكود مكرر في الشيت"], needs: ["code"] });
    }
  };
  const [item] = (await plan([target])).items;
  markRepeat(item);
  items[at] = item;
  // The twins of the old code were marked "repeated" only because of this row: plan them again now that it has moved on.
  if (oldCode && item.code !== oldCode) {
    const thrown = rowSet(imp.payload.discarded);
    const applied = appliedRows(imp);
    const twins = items.filter((i) => i.row !== item.row && i.code === oldCode && i.kind === "invalid" && (i.reasons || []).some((r) => /Code repeated in the sheet|الكود مكرر في الشيت/.test(r)) && !thrown.has(i.row) && !applied.has(i.row));
    const twinRows = rows.filter((r) => twins.some((t) => t.row === r.rowNumber));
    if (twinRows.length) {
      for (const fresh of (await plan(twinRows)).items) {
        items[items.findIndex((i) => i.row === fresh.row)] = fresh;
        markRepeat(fresh);
      }
    }
  }
  const columns = [...new Set([...(imp.payload.columns || []), ...Object.keys(target.cells)])];
  const info = imp.payload.info ? { ...imp.payload.info, no_phone_column: !columns.includes("owner_phone") } : imp.payload.info;
  return savePayload(pool, id, imp, { ...imp.payload, items, counts: countKinds(items), columns, ...(info ? { info } : {}) });
}

/** Writes a whole payload only if nobody changed the row since it was loaded (xmin) and it is still ready; false when refused. */
async function savePayload(pool, id, imp, payload) {
  const res = await pool.query("UPDATE web_imports SET payload = $2::jsonb WHERE id = $1 AND status = 'ready' AND xmin::text = $3", [id, JSON.stringify(payload), imp.row_version]);
  return res.rowCount > 0;
}

/* Batch changes: one decision for every row it fits (rent for the whole sheet, how to read several prices, a dollar rate). */

const cellText = (r, k) => (r.cells[k] === undefined || r.cells[k] === null ? "" : String(r.cells[k]));
const hasSeveralPrices = (r) => {
  const t = cellText(r, "price_value");
  return Boolean(t) && !Mixed.FOREIGN.test(t) && SheetImport.money(t) === null && Mixed.priceText(t)?.ambiguous === true;
};
const isDollars = (r) => Mixed.dollars(cellText(r, "price_value")) !== null;

const typeKey = (v) => String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase();
/** The type words the sheet uses that the app does not know, most used first: [{ value, count }]. */
function unknownTypes(rows) {
  const seen = new Map();
  for (const r of rows) {
    const v = typeKey(r.cells.property_type);
    if (v && !SheetImport.propertyType(v)) seen.set(v, (seen.get(v) || 0) + 1);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([value, count]) => ({ value, count }));
}
/** What a word in the type column can also be: a place (the compound) or noise. */
const TYPE_WORD_CHOICES = ["compound", "ignore"];
// What an unknown word in the type column can be: not only a compound or a unit type. "field:value" carries the value
// (a compound name from the place search, a floor, a finishing key, ...); "notes" and "ignore" keep the word in the notes.
const WORD_FIELDS = ["type", "compound", "floor", "finishing", "furnishing", "features", "notes", "ignore"];
const FINISHING_KEYS = Object.keys(Describe.FINISHING_LABELS);
const FURNISHING_KEYS = Object.keys(Describe.FURNISHING_LABELS);
/** "floor:3" → { field: "floor", payload: "3" }; a bare type key, "compound" or "ignore" is read as before; null when not valid. */
function parseWordChoice(value) {
  const v = String(value ?? "");
  if (TYPE_KEYS.includes(v)) return { field: "type", payload: v };
  if (TYPE_WORD_CHOICES.includes(v) || v === "notes") return { field: v, payload: "" };
  const i = v.indexOf(":");
  if (i < 1) return null;
  const field = v.slice(0, i);
  const payload = v.slice(i + 1).replace(/\s+/g, " ").trim().slice(0, 120);
  if (!WORD_FIELDS.includes(field) || field === "notes" || field === "ignore") return null;
  if (field === "type") return TYPE_KEYS.includes(payload) ? { field, payload } : null;
  if (field === "finishing") return FINISHING_KEYS.includes(payload) ? { field, payload } : null;
  if (field === "furnishing") return FURNISHING_KEYS.includes(payload) ? { field, payload } : null;
  return { field, payload };
}
/** The field an unknown word most likely is, to pre-pick the dropdown: a known place, a floor, a finishing or furnishing word, else notes. */
function suggestWordField(word, place = null) {
  const w = String(word ?? "").replace(/\s+/g, " ").trim();
  if (place) return { field: "compound", payload: place };
  if (/(^|\s)(\d{1,2}(st|nd|rd|th)?\s*floor|floor\s*\d{1,2}|الدور|دور)(\s|$)/i.test(w)) return { field: "floor", payload: (w.match(/\d{1,2}/) || [""])[0] };
  const fin = SheetImport.finishing(w);
  if (fin) return { field: "finishing", payload: fin };
  const fur = SheetImport.furnishing(w);
  if (fur) return { field: "furnishing", payload: fur };
  return { field: "notes", payload: "" };
}
const TYPE_KEYS = ["apartment", "duplex", "penthouse", "chalet", "studio", "villa", "townhouse", "triplex", "triplex_roof", "sky_loft", "basement", "i_villa", "twin_villa", "maisonette", "office", "shop", "clinic", "commercial", "land", "roof"];

/**
 * Which of the unknown type-column words are approved places (the source list: compounds, areas), so the review offers
 * "this is a compound" first. → { word: place name }
 */
async function typeWordPlaces(pool, words = []) {
  const out = {};
  if (!words.length) return out;
  const Places = require("../domain/mapPlaces");
  const { rows } = await pool.query("SELECT id, name_en, name_ar, aliases, verified, area_id, subzone_id FROM map_places WHERE approved").catch(() => ({ rows: [] }));
  const index = Places.buildIndex(rows);
  for (const w of words) {
    const id = index.get(Places.placeKey(w));
    const row = id && rows.find((r) => r.id === id);
    if (row) out[w] = row.name_en || row.name_ar;
  }
  return out;
}

/** How many rows each batch action would touch, for the review page. */
function batchStats(payload) {
  const applied = rowSet(payload.applied_rows);
  const rows = (payload.rows || []).filter((r) => !applied.has(r.rowNumber));
  return {
    no_type: (payload.items || []).filter((i) => i.kind === "invalid" && (i.needs || []).includes("listing_type")).length,
    several_prices: rows.filter(hasSeveralPrices).length,
    dollars: rows.filter(isDollars).length,
    status_hints: payload.defaults?.status_words ? [] : (() => {
      const by = {};
      for (const r of rows) {
        const h = SheetImport.statusHint(r.cells);
        if (h) by[h] = (by[h] || 0) + 1;
      }
      return Object.entries(by).map(([status, count]) => ({ status, count }));
    })(),
    remembered: payload.remembered || {},
    unknown_types: unknownTypes(rows)
  };
}

/**
 * Applies one batch change to a ready Excel plan's cells and plans the sheet again.
 * @param {{ action: "listing_type"|"price_pick"|"type_map", value: string, scope?: "missing"|"all" }} change
 * @returns {Promise<{ touched: number } | null>} null when the plan is not ready or expired
 */
async function batchExcel(pool, broker, id, { action, value, scope = "missing", from = "" }, { lang = "ar" } = {}) {
  const imp = await loadImport(pool, broker, id);
  if (!imp || imp.kind !== "excel" || imp.status !== "ready" || new Date(imp.expires_at) <= new Date()) return null;
  const allRows = Array.isArray(imp.payload.rows) ? imp.payload.rows : [];
  // Rows an Apply already wrote are left alone: a batch change only touches (and plans again) the rows still to be applied.
  const applied = appliedRows(imp);
  const rows = allRows.filter((r) => !applied.has(r.rowNumber));
  const defaults = { ...(imp.payload.defaults || {}) };
  let columns = imp.payload.columns;
  const original = (r, text) => {
    r.cells.notes = [r.cells.notes, `${lang === "en" ? "Price in the sheet" : "السعر في الشيت"}: ${text}`].filter(Boolean).join(" · ");
  };
  let touched = 0;
  if (action === "listing_type" && ["rent", "sale"].includes(value)) {
    for (const r of rows) {
      if (scope === "all" || !cellText(r, "listing_type").trim()) {
        r.cells.listing_type = value;
        touched++;
      }
    }
    defaults.listing_type = value;
  } else if (action === "owner_phone") {
    // One owner phone for every row that has none (scope "all": for every row).
    const phone = require("../domain/phone").normalizePhone(value);
    if (!phone) return { touched: 0, error: "bad_phone" };
    for (const r of rows) {
      if (scope === "all" || !cellText(r, "owner_phone").trim()) {
        r.cells.owner_phone = String(value).trim().slice(0, 40);
        touched++;
      }
    }
    if (touched && Array.isArray(columns)) columns = [...new Set([...columns, "owner_phone"])];
  } else if (action === "price_pick" && ["long", "first"].includes(value)) {
    for (const r of rows) {
      if (!hasSeveralPrices(r)) continue;
      const v = Mixed.pickPrice(cellText(r, "price_value"), value);
      if (!v) continue;
      original(r, cellText(r, "price_value"));
      r.cells.price_value = v;
      touched++;
    }
  } else if (action === "type_map" && parseWordChoice(value) && typeKey(from)) {
    const choice = parseWordChoice(value);
    for (const r of rows) {
      if (typeKey(r.cells.property_type) === typeKey(from) && !SheetImport.propertyType(r.cells.property_type)) {
        const word = String(r.cells.property_type).replace(/\s+/g, " ").trim();
        if (choice.field === "compound") {
          // The word in the type column is a place: the person says it is the unit's compound (as typed, or the one picked from the
          // place search), so it replaces the tab-name guess.
          r.cells.compound = choice.payload || word;
          delete r.cells.property_type;
        } else if (choice.field === "notes" || choice.field === "ignore") {
          // Not a type and not a place (a typo, a note): dropped from the type, kept in the notes.
          r.cells.notes = [r.cells.notes, word].filter(Boolean).join(" · ");
          delete r.cells.property_type;
        } else if (choice.field === "floor" || choice.field === "finishing" || choice.field === "furnishing") {
          r.cells[choice.field] = choice.payload || word;
          delete r.cells.property_type;
        } else if (choice.field === "features") {
          r.cells.features = [r.cells.features, choice.payload || word].filter(Boolean).join("، ");
          delete r.cells.property_type;
        } else {
          r.cells.property_type = choice.payload;
        }
        touched++;
      }
    }
  }
  if (action === "status_words" && ["yes", "no"].includes(value)) {
    // Asked once: yes sets rented or sold units to sold and closed ones to archived; the answer is remembered.
    defaults.status_words = value;
    await savePrefs(pool, broker.agency_id, { status_words: value === "yes" });
    if (value === "yes") {
      for (const r of rows) {
        const hint = SheetImport.statusHint(r.cells);
        if (hint) {
          r.cells.status = hint;
          touched++;
        }
      }
    }
    if (!touched) {
      return (await savePayload(pool, id, imp, { ...imp.payload, defaults })) ? { touched: 0 } : { touched: 0, error: "conflict" };
    }
  } else if (action === "forget_prefs") {
    await forgetPrefs(pool, broker.agency_id);
    return (await savePayload(pool, id, imp, { ...imp.payload, remembered: {} })) ? { touched: 0 } : { touched: 0, error: "conflict" };
  }
  if (!touched) return { touched: 0 };
  if (action === "price_pick") await savePrefs(pool, broker.agency_id, { price_pick: value });
  if (action === "type_map") await savePrefs(pool, broker.agency_id, { types: { [typeKey(from)]: value } });
  const oldItems = imp.payload.items || [];
  const appliedCodes = oldItems.filter((i) => applied.has(i.row) && i.code).map((i) => i.code);
  const plan = await planExcel(pool, broker, { rows, skipped: imp.payload.skipped || [], mapped: columns }, { lang, source: imp.payload.source || null, seenCodes: appliedCodes });
  // The rows an Apply wrote keep their item; the others take the new plan (one item per row, in the old order).
  const fresh = new Map(plan.items.map((i) => [i.row, i]));
  const items = applied.size ? oldItems.map((o) => (applied.has(o.row) ? o : fresh.get(o.row) || o)) : plan.items;
  if (!(await savePayload(pool, id, imp, { ...imp.payload, ...plan, items, counts: countKinds(items), rows: allRows, defaults, ...(columns ? { columns } : {}) }))) return { touched: 0, error: "conflict" };
  return { touched };
}

/* ---------------------------------------------------------------------- */
/* Group import: forwarded posts and chat exports                           */
/* ---------------------------------------------------------------------- */

const jobs = new Map(); // import id → promise (tests and graceful shutdown can wait for it)

/** An active unit that looks like this one (the shared P13 rule). */
const findDuplicate = (pool, agencyId, l) => Store.findDuplicate(pool, agencyId, l);

/**
 * Extracts every post with the WhatsApp listing extraction (two at a time) and stores the results
 * progressively in the import's payload; status becomes ready (or failed).
 */
async function processGroup(pool, broker, id, { AI, ctx, lang = "ar" }) {
  const imp = await loadImport(pool, broker, id);
  const posts = imp.payload.posts || [];
  const results = new Array(posts.length).fill(null);
  const limit = U.createLimiter(2);
  let stopped = null;
  const places = await require("./chatPlan").loadPlaces(pool).catch(() => null);
  const defaults = imp.payload.defaults || {};
  const save = (status = "processing") =>
    pool.query("UPDATE web_imports SET payload = jsonb_set(payload, '{results}', $2::jsonb), status = $3 WHERE id = $1", [id, JSON.stringify(results), status]);

  await Promise.all(
    posts.map((post, i) =>
      limit(async () => {
        if (stopped) {
          results[i] = { i, error: stopped };
          return;
        }
        try {
          // Rules only (Parser consolidation, Phase 6): the same post reader the chat import uses; what it cannot read stays empty and shows as missing.
          const read = ChatListing.parsePost(post.text, places, post);
          // The price the same way an Excel cell is read: several prices pick the long-term or monthly one, dollars stay dollars.
          const price = Mixed.installmentOf(read.cells.price_value) ? { value: read.cells.price_value, usd: false } : Mixed.cellPrice(read.cells.price_value);
          const ex = { fields: SheetImport.rowToDraft(price.value === read.cells.price_value ? read.cells : { ...read.cells, price_value: price.value }).draft || {} };
          if (price.usd) ex.fields.details = { ...(ex.fields.details || {}), currency: "USD" };
          // "All rent" / "All sale" from the review page fills only posts that did not say.
          if (!ex.fields.listing_type && defaults.listing_type) ex.fields.listing_type = defaults.listing_type;
          // The compound's English name too, so the duplicate check matches "هايد بارك" with "Hyde Park".
          const place = read.cells.compound && places?.rows.find((p) => p.name_ar === read.cells.compound || p.name_en === read.cells.compound);
          if (place?.name_en) ex.fields.details = { ...(ex.fields.details || {}), compound_en: place.name_en };
          const composed = L.composeFields({ draft: ex.fields, lang });
          // A phone in the post is the owner's contact: every unit needs one before it is saved.
          const ownerPhone = (String(post.text).match(/(?<!\d)(?:\+?20)?0?1[0125]\d{8}(?!\d)/) || [])[0] || null;
          composed.details = { ...composed.details, source: "group_import", ...(ownerPhone ? { owner_phone: ownerPhone } : {}), ...(post.sender ? { co_broker: post.sender } : {}), ...(ex.fields.code ? { source_ref: ex.fields.code } : {}) };
          const ev = Rules.evaluate(composed, { lang });
          results[i] = {
            i,
            ok: ev.ok,
            fields: ev.listing,
            blockers: ev.blockers.map((b) => reasonOf(b, lang)),
            warnings: ev.warnings.map((w) => Rules.warningLine(w, lang)),
            duplicate: ev.ok ? await findDuplicate(pool, broker.agency_id, ev.listing) : null
          };
        } catch (err) {
          const why = AiBlock.kindOf(err);
          if (why !== "ai") stopped = why;
          results[i] = { i, error: stopped || "ai" };
        }
        await save().catch(() => {});
      })
    )
  );
  // Posts inside one paste that describe the same unit (the same rule): the later one points at the first.
  results.forEach((r, i) => {
    if (!r?.ok || r.duplicate) return;
    const j = results.findIndex((o, k) => k < i && o?.ok && o.same_as === undefined && Dup.sameUnit(r.fields, o.fields));
    if (j >= 0) r.same_as = j;
  });
  await save("ready");
}

/**
 * Saves the posts and starts extracting them in the background. Returns the import id.
 * Posts may carry photos [{ url, hash }]; the match page adds them one by one after the import starts.
 */
async function startGroupImport(pool, broker, posts, { AI, ctx, lang = "ar", filename = null }) {
  const id = await savePlan(pool, broker, "group", { posts, results: [] }, { filename, status: "processing" });
  const job = new Promise((resolve) => setImmediate(resolve))
    .then(async () => {
      await processGroup(pool, broker, id, { AI, ctx, lang });
    })
    .catch(async (err) => {
      console.error("Group import failed:", err.message);
      await pool.query("UPDATE web_imports SET status = 'failed' WHERE id = $1", [id]).catch(() => {});
    })
    .finally(() => {
      jobs.delete(id);
    });
  jobs.set(id, job);
  return id;
}

/** The review page's "all rent" / "all sale": posts that did not say get it, and every post is read again (photos stay). */
async function setGroupListingType(pool, broker, id, value, { AI, ctx, lang = "ar" } = {}) {
  if (!["rent", "sale"].includes(value)) return null;
  const { rows } = await pool.query(
    "UPDATE web_imports SET payload = jsonb_set(payload, '{defaults}', $4::jsonb), status = 'processing' WHERE id = $1 AND agency_id = $2 AND broker_id = $3 AND kind = 'group' AND status = 'ready' AND expires_at > NOW() RETURNING id",
    [id, broker.agency_id, broker.id, JSON.stringify({ listing_type: value })]
  );
  if (!rows[0]) return null;
  const job = processGroup(pool, broker, id, { AI, ctx, lang })
    .catch(async () => { await pool.query("UPDATE web_imports SET status = 'failed' WHERE id = $1", [id]).catch(() => {}); })
    .finally(() => jobs.delete(id));
  jobs.set(id, job);
  return id;
}

/** Resolves when a running group import finishes (immediately if none). */
function waitForGroupImport(id) {
  return jobs.get(id) || Promise.resolve();
}

/** Creates the selected, complete posts as new units (generated codes; the poster stays internal). */
async function applyGroup(pool, broker, id, { rows = [], lang = "ar" } = {}) {
  const imp = await claim(pool, broker, id, "group");
  if (!imp) return null;
  const wanted = new Set(rows.map(Number));
  const result = { created: [], failed: [] };
  const posts = imp.payload.posts || [];
  const used = new Set();
  for (const r of imp.payload.results || []) {
    if (!r || !wanted.has(r.i) || !r.ok) continue;
    const res = await insertOne(pool, broker, r.fields, null, lang, `import:${id}`);
    if (!res.listing) {
      result.failed.push(r.i);
      if (res.limit) result.limit = res.limit;
      continue;
    }
    result.created.push(res.listing.code);
    // Photos from a chat export zip go on the new unit, with their hashes for the duplicate-photo flag.
    const photos = (posts[r.i]?.photos || []).filter((p) => p.url);
    if (photos.length) {
      await Store.addPhotos(pool, res.listing, photos.map((p) => p.url));
      await PhotoHash.saveHashes(pool, broker.agency_id, new Map(photos.map((p) => [p.url, p.hash])));
      photos.forEach((p) => used.add(p.url));
    }
  }
  const unused = posts.flatMap((p) => (p.photos || []).map((x) => x.url)).filter((u) => u && !used.has(u));
  if (unused.length) await Supabase.deleteStorageFiles(unused);
  await pool.query("UPDATE web_imports SET result = $2::jsonb WHERE id = $1", [id, JSON.stringify(result)]);
  return result;
}

/**
 * The photo choices the person made on a chat plan's row (which uploaded photos to keep, in which order, which of the unit's
 * own to remove), kept in the plan so editing the row's fields does not reset them. Only a ready plan of this broker.
 */
async function setPhotoChoice(pool, broker, id, row, { order = [], keep = [], drop = [] } = {}) {
  const ints = (v) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 100))];
  const choice = { order: ints(order), keep: ints(keep), drop: (Array.isArray(drop) ? drop : []).map(String).filter((x) => /^[0-9a-f-]{36}$/.test(x)) };
  const { rowCount } = await pool.query(
    `UPDATE web_imports SET payload = jsonb_set(jsonb_set(payload, '{choices}', COALESCE(payload->'choices', '{}'::jsonb), true), ARRAY['choices', $2::text], $3::jsonb, true)
      WHERE id = $1 AND agency_id = $4 AND broker_id = $5 AND status = 'ready' AND kind = 'excel'`,
    [id, String(Number(row)), JSON.stringify(choice), broker.agency_id, broker.id]
  );
  return rowCount > 0;
}

/**
 * Moves one uploaded photo of a chat plan to the unit before or after it in the chat (the neighbouring row that is still
 * to be saved or fixed). The photo choices of both rows follow it: the moved photo is added last and ticked on the new unit.
 * @returns {Promise<boolean>} false when there is nothing to move to or the plan is not a ready chat plan
 */
async function movePhoto(pool, broker, id, { row, index, dir } = {}) {
  const imp = await loadImport(pool, broker, id);
  if (!imp || imp.kind !== "excel" || imp.status !== "ready" || imp.payload?.source !== "chat") return false;
  const p = imp.payload;
  const thrown = new Set((p.discarded || []).map(Number));
  const rows = (p.items || []).filter((i) => ["new", "changed", "review", "invalid"].includes(i.kind) && !thrown.has(i.row)).map((i) => i.row).sort((a, b) => a - b);
  const at = rows.indexOf(Number(row));
  const to = at < 0 ? undefined : rows[at + (dir === "prev" ? -1 : 1)];
  const photos = { ...(p.photos || {}) };
  const from = [...(photos[String(row)] || [])];
  if (to === undefined || !Number.isInteger(index) || index < 0 || index >= from.length) return false;
  const [moved] = from.splice(index, 1);
  const dest = [...(photos[String(to)] || []), moved];
  photos[String(row)] = from;
  photos[String(to)] = dest;
  const choices = { ...(p.choices || {}) };
  const shift = (list) => (list || []).filter((x) => x !== index).map((x) => (x > index ? x - 1 : x));
  const a = choices[String(row)];
  if (a) choices[String(row)] = { ...a, order: shift(a.order), keep: shift(a.keep) };
  const b = choices[String(to)];
  if (b) choices[String(to)] = { ...b, order: [...(b.order || []), dest.length - 1], keep: [...(b.keep || []), dest.length - 1] };
  const { rowCount } = await pool.query(
    `UPDATE web_imports SET payload = jsonb_set(jsonb_set(payload, '{photos}', $2::jsonb, true), '{choices}', $3::jsonb, true)
      WHERE id = $1 AND agency_id = $4 AND broker_id = $5 AND status = 'ready' AND kind = 'excel'`,
    [id, JSON.stringify(photos), JSON.stringify(choices), broker.agency_id, broker.id]
  );
  return rowCount > 0;
}

/**
 * Throws rows of a ready chat plan away (or brings them back), kept in the plan: a discarded row is hidden in the review and never
 * written or given photos by apply, whatever the page sends. scope "errors" (rows with errors), "unchanged" (existing units with no
 * change) or rows: [row numbers]; on=false restores (rows, or scope "all").
 * @returns {Promise<number|null>} how many rows changed state, null when the plan is not a ready plan of this broker
 */
async function setDiscarded(pool, broker, id, { rows = [], scope = null, on = true } = {}) {
  const imp = await loadImport(pool, broker, id);
  if (!imp || imp.kind !== "excel" || imp.status !== "ready") return null;
  const items = imp.payload.items || [];
  const have = new Set((imp.payload.discarded || []).map(Number));
  const known = new Set(items.map((i) => i.row));
  let target;
  if (scope === "errors") target = items.filter((i) => i.kind === "invalid" || i.kind === "forbidden").map((i) => i.row);
  else if (scope === "unchanged") target = items.filter((i) => i.kind === "unchanged").map((i) => i.row);
  else if (scope === "all" && !on) target = [...have];
  else target = (Array.isArray(rows) ? rows : []).map(Number).filter((n) => Number.isInteger(n) && known.has(n));
  const next = new Set(have);
  for (const n of target) (on ? next.add(n) : next.delete(n));
  const changed = [...next].filter((n) => !have.has(n)).length + [...have].filter((n) => !next.has(n)).length;
  // The same choice is remembered for the chat (Restore forgets it), so another import of this chat starts the same way.
  const pfpsOf = (rowsList) => rowsList.map((n) => imp.payload.posts?.[n - 1]?.pfp).filter(Boolean);
  if (imp.payload.chat_fp) {
    await rememberRows(pool, broker, imp.payload, [...next].filter((n) => !have.has(n)).map((n) => [n, "discarded"]));
    const back = pfpsOf([...have].filter((n) => !next.has(n)));
    if (back.length) await Decisions.forget(pool, broker.agency_id, imp.payload.chat_fp, back).catch(() => {});
  }
  await pool.query(
    "UPDATE web_imports SET payload = jsonb_set(payload, '{discarded}', $2::jsonb, true) WHERE id = $1 AND agency_id = $3 AND broker_id = $4 AND status = 'ready' AND kind = 'excel'",
    [id, JSON.stringify([...next].sort((a, b) => a - b)), broker.agency_id, broker.id]
  );
  return changed;
}

/**
 * "Forget remembered decisions for this chat": every remembered decision of the chat is removed (for the whole agency), and this plan
 * goes back to a plain one: posts that started discarded because of a memory are restored, nothing is hidden or unticked.
 * @returns {Promise<number|null>} decisions removed, null when the plan is not a ready chat plan
 */
async function forgetChatDecisions(pool, broker, id) {
  const imp = await loadImport(pool, broker, id);
  if (!imp || imp.kind !== "excel" || imp.status !== "ready" || imp.payload?.source !== "chat") return null;
  const removed = imp.payload.chat_fp ? await Decisions.forget(pool, broker.agency_id, imp.payload.chat_fp) : 0;
  const was = imp.payload.remembered || {};
  const discarded = (imp.payload.discarded || []).map(Number).filter((n) => was[n] !== "discarded");
  await pool.query(
    "UPDATE web_imports SET payload = jsonb_set(jsonb_set(payload, '{remembered}', '{}'::jsonb, true), '{discarded}', $2::jsonb, true) WHERE id = $1 AND agency_id = $3 AND broker_id = $4 AND status = 'ready' AND kind = 'excel'",
    [id, JSON.stringify(discarded), broker.agency_id, broker.id]
  );
  return removed;
}

/** The Arabic name and map link asked for a new compound on a chat plan's row, kept in the plan until the unit is saved. */
async function setNewPlace(pool, broker, id, row, { nameAr = "", pin = "" } = {}) {
  const { rowCount } = await pool.query(
    `UPDATE web_imports SET payload = jsonb_set(jsonb_set(payload, '{newPlaces}', COALESCE(payload->'newPlaces', '{}'::jsonb), true), ARRAY['newPlaces', $2::text], $3::jsonb, true)
      WHERE id = $1 AND agency_id = $4 AND broker_id = $5 AND status = 'ready' AND kind = 'excel'`,
    [id, String(Number(row)), JSON.stringify({ nameAr: String(nameAr).slice(0, 120), pin: String(pin).slice(0, 500) }), broker.agency_id, broker.id]
  );
  return rowCount > 0;
}

module.exports = {
  fieldsOfCells,
  typeWordPlaces,
  TYPE_WORD_CHOICES,
  WORD_FIELDS,
  FINISHING_KEYS,
  FURNISHING_KEYS,
  parseWordChoice,
  suggestWordField,
  missingCells,
  setNewPlace,
  movePhoto,
  setPhotoChoice,
  setDiscarded,
  escapeRegex,
  escapeLike,
  describeChanges,
  forgetChatDecisions,
  planExcel,
  savePlan,
  loadImport,
  applyExcel,
  startApplyExcel,
  applyStatus,
  waitForApply,
  remainingRows,
  appliedRows,
  failReason,
  failedLine,
  failedCode,
  editExcelRow,
  batchExcel,
  batchStats,
  canUndo,
  undoPreview,
  undoExcel,
  TYPE_KEYS,
  findDuplicate,
  startGroupImport,
  setGroupListingType,
  waitForGroupImport,
  applyGroup
};
