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
const Mixed = require("../domain/sheetMixed");
const SheetGrid = require("../lib/sheetGrid");
const Dup = require("../domain/unitDuplicate");
const { normalizeCode } = require("../domain/searchQuery");
const { normalizeSearch } = require("../domain/searchText");
const Supabase = require("../lib/supabase");
const PhotoHash = require("./photoHash");
const ParseLog = require("./chatParseLog");
const { MAX_PHOTOS } = require("../lib/images");
const Vis = require("../lib/visibility");

const MONEY = ["price_value", "down_payment_value", "remaining_amount", "installment_value"];
const DETAIL_LABELS = { owner_name: ["المالك", "Owner"], owner_phone: ["تليفون المالك", "Owner phone"], notes: ["ملاحظات", "Notes"], clean_summary: ["الوصف", "Description"], summary_en: ["الوصف بالإنجليزي", "English summary"], floor: ["الدور", "Floor"] };
const STATUS = { active: ["متاحة", "Available"], sold: ["مباعة", "Sold"], archived: ["مؤرشفة", "Archived"] };
const pick = (pair, lang) => (pair ? pair[lang === "en" ? 1 : 0] : null);

function display(col, v, lang) {
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return "—";
  if (MONEY.includes(col)) return Describe.money(v, lang) || String(v);
  if (col === "feature_keys") return v.map((k) => Features.featureLabel(k, lang)).join("، ");
  if (col === "finishing") return pick(Describe.FINISHING_LABELS[v], lang) || v;
  if (col === "status") return pick(STATUS[v], lang) || v;
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

const reasonOf = (b, lang) => (lang === "en" ? b.label_en : b.label_ar);
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
  property_type: ["نوع غير معروف", "Unknown type"],
  price_value: ["سعر غير صحيح", "Invalid price"],
  currency: ["السعر بعملة غير الجنيه (لازم جنيه مصري)", "Price not in EGP (must be Egyptian pounds)"],
  area_value: ["مساحة غير صحيحة", "Invalid area"]
};
const NOTE = {
  compound: (raw, to, lang) => (lang === "en" ? `Compound "${raw}" matched to your existing "${to}"` : `الكمبوند "${raw}" اتربط بـ "${to}" الموجود عندك`),
  phone: (lang) => (lang === "en" ? "Owner phone does not look like an Egyptian mobile" : "تليفون المالك مش شكل موبايل مصري"),
  dollar: (usd, lang) => (lang === "en" ? `Priced in dollars: saved as $${usd}, not converted` : `السعر بالدولار: اتسجل ${usd}$ من غير تحويل`),
  dupDb: (code, lang) => (lang === "en" ? `Looks like your existing unit ${code}` : `شكلها نفس وحدتك ${code}`),
  dupRow: (row, lang) => (lang === "en" ? `Looks like row ${row} in this sheet` : `شكلها نفس الصف ${row} في الشيت`),
  codeMade: (lang) => (lang === "en" ? "No code in the sheet: numbered in the sheet's own pattern" : "مفيش كود في الشيت: اتعمل بنفس نمط أكواد الشيت"),
  codePattern: (lang) => (lang === "en" ? "Code does not follow the sheet's pattern" : "الكود مش على نمط أكواد الشيت")
};
const EGY_PHONE = /^(\+?20|0)?1[0-9]{9}$/;
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
async function planExcel(pool, broker, sheet, { lang = "ar", source = null } = {}) {
  let remembered = null;
  if (sheet.tabs) {
    // Earlier choices are only offered on the review page (pre-selected), never applied without a tap.
    remembered = await importPrefs(pool, broker.agency_id);
    await applyCodePatterns(pool, broker.agency_id, sheet);
  }
  // A cell with several prices takes the long-term or monthly one; a price in dollars is kept in dollars (saved with its
  // currency, like a unit added by voice or text); search converts it.
  const parsed = sheet.rows.map((r) => {
    // An installment plan in the price cell is read whole by the importer (not as one of several prices).
    const price = Mixed.installmentOf(r.cells.price_value) ? { value: r.cells.price_value, usd: false } : Mixed.cellPrice(r.cells.price_value);
    const usd = price.usd ? price.value : null;
    const row = SheetImport.rowToDraft(price.value === r.cells.price_value ? r.cells : { ...r.cells, price_value: price.value });
    if (usd && row.draft) row.draft.details = { ...(row.draft.details || {}), currency: "USD" };
    // A cell with several prices: the price the rule did not pick is kept in the description, with the one it picked.
    if (!price.usd && price.value !== r.cells.price_value && row.draft) {
      row.draft.details = { ...(row.draft.details || {}), clean_summary: [row.draft.details?.clean_summary, String(r.cells.price_value).trim()].filter(Boolean).join(" · ") };
    }
    return { rowNumber: r.rowNumber, tab: r.tab || null, sheetRow: r.sheetRow || null, ...row, cells: r.cells, dollar: usd ? { usd } : null, codeMade: Boolean(r.code_made), codeOdd: Boolean(r.code_odd), hint: SheetImport.statusHint(r.cells) };
  });
  const codes = [...new Set(parsed.map((p) => normalizeCode(p.code)).filter(Boolean))];
  const { rows: found } = await pool.query("SELECT * FROM listings WHERE " + Vis.units("listings") + " AND agency_id = $1 AND code_norm = ANY($2::text[])", [broker.agency_id, codes]);
  const byCode = new Map(found.map((l) => [l.code_norm, l]));
  const known = await knownCompounds(pool, broker.agency_id);
  const seen = new Set();
  const items = [];
  const sheetNew = [];
  // Rows that had text but no known column are shown with their reason, never dropped.
  for (const s of sheet.skipped || []) items.push({ row: s.rowNumber, tab: s.tab || null, sheet_row: s.sheetRow || null, code: null, kind: "invalid", reasons: [lang === "en" ? "No value in a known column" : "مفيش قيمة في عمود معروف"], needs: [], notes: [] });

  for (const p of parsed) {
    const code = normalizeCode(p.code);
    const base = { row: p.rowNumber, tab: p.tab, sheet_row: p.sheetRow, code: code || null, notes: [] };
    if (p.dollar) base.notes.push(NOTE.dollar(p.dollar.usd, lang));
    if (p.codeMade) base.notes.push(NOTE.codeMade(lang));
    if (p.codeOdd) base.notes.push(NOTE.codePattern(lang));
    if (p.hint) base.status_hint = p.hint;
    if (p.errors.length) {
      items.push({ ...base, kind: "invalid", reasons: p.errors.map((e) => quoted(e, p.cells, lang)), needs: [...new Set(p.errors.map((e) => ERROR_NEEDS[e]).filter(Boolean))] });
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
    if (phone && !EGY_PHONE.test(phone.replace(/[\s-]/g, ""))) base.notes.push(NOTE.phone(lang));
    if (code && seen.has(code)) {
      items.push({ ...base, kind: "invalid", reasons: [lang === "en" ? "Code repeated in the sheet" : "الكود مكرر في الشيت"], needs: ["code"] });
      continue;
    }
    if (code) seen.add(code);
    const existing = code ? byCode.get(code) : null;
    if (existing) {
      if (!Authz.canEdit(broker, existing)) {
        items.push({ ...base, code: existing.code, kind: "forbidden", reasons: [lang === "en" ? "Another broker's unit" : "وحدة وسيط تاني"] });
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
      const changes = describeChanges(existing, patch, lang);
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
      if (p.status && p.status !== "active") ev.listing.status = p.status;
      const warnings = ev.warnings.map((w) => Rules.warningLine(w, lang));
      // A likely duplicate: an active unit in the agency, or an earlier row of this sheet (never a block, only a warning).
      const dup = await Store.findDuplicate(pool, broker.agency_id, ev.listing);
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
          sheetNew.push(item);
          items.push(item);
          continue;
        }
      }
      if (!dup) {
        const twin = sheetNew.find((o) => Dup.sameUnit(ev.listing, o.fields));
        if (twin) warnings.push(NOTE.dupRow(twin.row, lang));
      }
      const item = { ...base, kind: "new", fields: ev.listing, warnings };
      sheetNew.push(item);
      items.push(item);
    }
  }

  const counts = items.reduce((acc, i) => ({ ...acc, [i.kind]: (acc[i.kind] || 0) + 1 }), {});
  return remembered ? { items, counts, remembered } : { items, counts };
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
  const { rows } = await pool.query("SELECT * FROM web_imports WHERE id = $1 AND agency_id = $2 AND broker_id = $3", [id, broker.agency_id, broker.id]);
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
    return { outcome: "updated", listing: res.listing };
  });
}

/**
 * Applies the selected rows of an Excel plan. Each row is its own transaction.
 * @returns {Promise<{ created, updated, conflicts, failed } | null>} null when the plan cannot be applied
 */
async function applyExcel(pool, broker, id, { rows = [], lang = "ar", resolutions = {}, photoChoices = {} } = {}) {
  const imp = await claim(pool, broker, id, "excel");
  if (!imp) return null;
  const started = Date.now();
  const wanted = new Set(rows.map(Number));
  const result = { created: [], updated: [], conflicts: [], failed: [], undo: { made: [], changed: [], photos: [] } };
  const photoMap = imp.payload.photos || {};
  const used = new Set();
  const withPhotos = async (item, listing) => {
    if (!listing) return;
    const list = photoMap[String(item.row)] || [];
    try {
      const urls = await attachChatPhotos(pool, broker, listing, list, photoChoices[item.row] || {}, result);
      urls.forEach((u) => used.add(u));
      result.photos = (result.photos || 0) + urls.length;
    } catch (err) {
      result.failed.push(`${listing.code} (photos)`);
      console.warn("Chat import photos failed:", err.message);
    }
  };
  const merge = async (item) => {
    const res = await patchOne(pool, broker, item.merge?.code || item.code, item.merge?.patch || item.patch, item.merge?.version ?? item.version);
    if (res.outcome === "updated") {
      result.updated.push(res.listing.code);
      result.undo.changed.push({ code: res.listing.code, before: item.merge?.before || item.before || {}, version: res.listing.version });
      await withPhotos(item, res.listing);
    } else (res.outcome === "conflict" ? result.conflicts : result.failed).push(item.merge?.code || item.code);
  };
  const insert = async (item, code) => {
    const res = await insertOne(pool, broker, item.fields, code, lang, `import:${id}`);
    if (res.listing) {
      result.created.push(res.listing.code);
      result.undo.made.push({ id: res.listing.id, code: res.listing.code, version: res.listing.version });
      await withPhotos(item, res.listing);
      return true;
    }
    if (res.limit) {
      result.limit = res.limit;
      return "limit";
    }
    if (res.owner_required || res.owner_name_required) result.failed.push(item.code || `row ${item.row}`);
    else result.conflicts.push(res.code);
    return false;
  };
  for (const item of imp.payload.items) {
    if (!wanted.has(item.row)) continue;
    if (item.kind === "new") {
      if ((await insert(item, item.code)) === "limit") break;
    } else if (item.kind === "changed") {
      await merge(item);
    } else if (item.kind === "review") {
      const pick = resolutions[item.row] || {};
      if (pick.mode === "merge" && item.merge) await merge(item);
      else {
        // A new unit: the code typed in the review, else the message's own code when it is free, else a generated one.
        const typed = pick.code ? normalizeCode(pick.code) : null;
        const code = typed || (item.code_taken ? null : item.code || null);
        if ((await insert(item, code)) === "limit") break;
      }
    }
  }
  const unused = Object.values(photoMap).flat().map((x) => x?.url).filter((u) => u && !used.has(u));
  if (unused.length) await Supabase.deleteStorageFiles(unused).catch(() => {});
  await pool.query("UPDATE web_imports SET result = $2::jsonb WHERE id = $1", [id, JSON.stringify(result)]);
  if (imp.payload.source === "chat") ParseLog.applied(pool, broker, id, imp.payload, wanted, Date.now() - started);
  return result;
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

/* Undo: only the agency's last applied Excel import. Units it added are archived (never deleted); units it changed get the
   values they had before. A unit edited since the import is skipped and listed, never overwritten. */

/** The agency's last applied Excel import that was not undone yet; null when there is none. */
async function lastApplied(pool, agencyId) {
  const { rows } = await pool.query(
    "SELECT * FROM web_imports WHERE agency_id = $1 AND kind = 'excel' AND status = 'applied' AND result IS NOT NULL ORDER BY applied_at DESC LIMIT 1",
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
    if (rows[0] && Number(rows[0].version) === Number(m.version) && rows[0].status !== "archived") archive.push(m);
    else skipped.push(m.code);
  }
  for (const c of log.changed) {
    const { rows } = await pool.query("SELECT version FROM listings WHERE " + Vis.units("listings") + " AND code_norm = $1 AND agency_id = $2", [normalizeCode(c.code), agencyId]);
    if (rows[0] && Number(rows[0].version) === Number(c.version)) restore.push(c);
    else skipped.push(c.code);
  }
  return { archive, restore, skipped };
}

/** Whether this broker may undo this import now (the last applied one, not yet undone). */
async function canUndo(pool, broker, imp) {
  if (!imp || imp.kind !== "excel" || imp.status !== "applied") return false;
  const last = await lastApplied(pool, broker.agency_id);
  return Boolean(last && last.id === imp.id);
}

/** Undoes the last applied Excel import. Claims it first, so a double press does nothing the second time. */
async function undoExcel(pool, broker, id) {
  const imp = await loadImport(pool, broker, id);
  if (!(await canUndo(pool, broker, imp))) return null;
  const { rows: claimed } = await pool.query(
    "UPDATE web_imports SET result = jsonb_set(result, '{undone}', $3::jsonb) WHERE id = $1 AND agency_id = $2 AND status = 'applied' AND NOT (result ? 'undone') RETURNING id",
    [id, broker.agency_id, JSON.stringify({ at: new Date().toISOString(), by: broker.id })]
  );
  if (!claimed[0]) return null;
  const plan = await undoPreview(pool, broker.agency_id, imp);
  const out = { archived: [], restored: [], skipped: [...plan.skipped] };
  for (const m of plan.archive) {
    const { rowCount } = await pool.query(
      "UPDATE listings SET status = 'archived', version = version + 1 WHERE id = $1 AND agency_id = $2 AND version = $3",
      [m.id, broker.agency_id, m.version]
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
    if (value) target.cells[key] = value;
    else delete target.cells[key];
  }
  // A type word the app did not know, fixed by hand in the review, is learned for the next upload.
  const newType = SheetImport.propertyType(target.cells.property_type);
  if (typeKey(oldType) && !SheetImport.propertyType(oldType) && newType) await savePrefs(pool, broker.agency_id, { types: { [typeKey(oldType)]: newType } });
  const [item] = (await planExcel(pool, broker, { rows: [target] }, { lang, source: imp.payload.source || null })).items;
  if (item.code && ["new", "changed"].includes(item.kind) && items.some((i) => i.row !== item.row && i.code === item.code && ["new", "changed"].includes(i.kind))) {
    Object.assign(item, { kind: "invalid", reasons: [lang === "en" ? "Code repeated in the sheet" : "الكود مكرر في الشيت"], needs: ["code"] });
  }
  items[at] = item;
  const columns = [...new Set([...(imp.payload.columns || []), ...Object.keys(target.cells)])];
  await pool.query("UPDATE web_imports SET payload = $2::jsonb WHERE id = $1 AND status = 'ready'", [id, JSON.stringify({ ...imp.payload, items, counts: countKinds(items), columns })]);
  return true;
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
const TYPE_KEYS = ["apartment", "duplex", "penthouse", "chalet", "studio", "villa", "townhouse", "triplex", "triplex_roof", "sky_loft", "basement", "mazonette", "i_villa", "twin_villa", "maisonette", "office", "shop", "clinic", "commercial", "land"];

/** How many rows each batch action would touch, for the review page. */
function batchStats(payload) {
  const rows = payload.rows || [];
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
  const rows = Array.isArray(imp.payload.rows) ? imp.payload.rows : [];
  const defaults = { ...(imp.payload.defaults || {}) };
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
  } else if (action === "price_pick" && ["long", "first"].includes(value)) {
    for (const r of rows) {
      if (!hasSeveralPrices(r)) continue;
      const v = Mixed.pickPrice(cellText(r, "price_value"), value);
      if (!v) continue;
      original(r, cellText(r, "price_value"));
      r.cells.price_value = v;
      touched++;
    }
  } else if (action === "type_map" && TYPE_KEYS.includes(value) && typeKey(from)) {
    for (const r of rows) {
      if (typeKey(r.cells.property_type) === typeKey(from) && !SheetImport.propertyType(r.cells.property_type)) {
        r.cells.property_type = value;
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
      await pool.query("UPDATE web_imports SET payload = $2::jsonb WHERE id = $1 AND status = 'ready'", [id, JSON.stringify({ ...imp.payload, defaults })]);
      return { touched: 0 };
    }
  } else if (action === "forget_prefs") {
    await forgetPrefs(pool, broker.agency_id);
    await pool.query("UPDATE web_imports SET payload = $2::jsonb WHERE id = $1 AND status = 'ready'", [id, JSON.stringify({ ...imp.payload, remembered: {} })]);
    return { touched: 0 };
  }
  if (!touched) return { touched: 0 };
  if (action === "price_pick") await savePrefs(pool, broker.agency_id, { price_pick: value });
  if (action === "type_map") await savePrefs(pool, broker.agency_id, { types: { [typeKey(from)]: value } });
  const plan = await planExcel(pool, broker, { rows, skipped: imp.payload.skipped || [] }, { lang, source: imp.payload.source || null });
  await pool.query("UPDATE web_imports SET payload = $2::jsonb WHERE id = $1 AND status = 'ready'", [id, JSON.stringify({ ...imp.payload, ...plan, rows, defaults })]);
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
          const ex = await L.extractPropertyDetails(AI, { texts: [post.text], lang, ctx });
          const composed = L.composeFields({ draft: ex.fields, lang });
          // A phone in the post is the owner's contact: every unit needs one before it is saved.
          const ownerPhone = (String(post.text).match(/(?:\+?20)?0?1[0125]\d{8}/) || [])[0] || null;
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

module.exports = {
  escapeRegex,
  escapeLike,
  describeChanges,
  planExcel,
  savePlan,
  loadImport,
  applyExcel,
  editExcelRow,
  batchExcel,
  batchStats,
  canUndo,
  undoPreview,
  undoExcel,
  TYPE_KEYS,
  findDuplicate,
  startGroupImport,
  waitForGroupImport,
  applyGroup
};
