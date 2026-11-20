// services/chatPlan.js — WhatsApp chat posts → an import plan, through the same planner Excel uses (services/imports.js).
// The parser reads every post (rules only, no AI). The plan is an "excel" import with source "chat", so the review, row editing, batch fixes,
// duplicate and same-unit checks, apply and undo are one code path for both.
"use strict";

const Places = require("../domain/mapPlaces");
const ChatListing = require("../domain/chatListing");
const Imports = require("./imports");
const ParseLog = require("./chatParseLog");
const Cells = require("../domain/importEditorCells");
const FP = require("../domain/chatFingerprint");
const Decisions = require("./chatDecisions");

const MAX_POSTS = 40;

/** The approved places, indexed for finding a compound inside a post. */
async function loadPlaces(pool) {
  const { rows } = await pool.query("SELECT id, name_en, name_ar, aliases, verified, area_id, subzone_id FROM map_places WHERE approved");
  return { rows, index: Places.buildIndex(rows) };
}

/**
 * @param {Array<{ sender?: string, at?: string, text: string }>} posts at most 40
 * @returns {Promise<{ id: string, posts: number, ai: number, aiBlocked: string|null, counts: object }>}
 */
async function planChat(pool, broker, posts, { lang = "ar", filename = null, chatFp = null } = {}) {
  const list = posts.slice(0, MAX_POSTS);
  const places = await loadPlaces(pool).catch(() => null);
  const logs = [];
  const parsed = list.map((p, i) => {
    const t0 = Date.now();
    const r = ChatListing.parsePost(p.text, places, p);
    logs[i] = { row: i + 1, text: p.text, read: r.read, missing: r.missing, suspect: r.suspect, parseMs: Date.now() - t0, ...(r.missing.length ? { aiSkipped: "rules_only" } : {}) };
    return r;
  });
  const areas = list.some((p) => p.fields) ? await require("./areas").approvedAreas(pool).catch(() => []) : [];
  const cells = parsed.map((r, i) => Cells.mergeEdits(r.cells, list[i].fields || null, { areas }));
  const newPlaces = {};
  list.forEach((p, i) => { const np = p.fields && Cells.newPlaceOf(p.fields); if (np) newPlaces[i + 1] = np; });
  const first = Object.fromEntries(parsed.map((r, i) => [i + 1, { ...r.cells }]));

  // Rules only (Parser consolidation, Phase 6): no AI call. What the parser cannot read stays empty and is completed in the Edit window.
  const aiCalls = 0;
  const blocked = null;

  const rows = cells.map((c, i) => ({ rowNumber: i + 1, cells: c }));
  const plan = await Imports.planExcel(pool, broker, { rows, skipped: [] }, { lang, source: "chat" });
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r.cells)))];
  // What the agency decided about these posts in an earlier import of the same chat (services/chatDecisions.js): a saved post is
  // hidden by default, a discarded one starts discarded, an unchanged one starts unticked. Every post carries its fingerprint.
  const fpOk = FP.isChatFp(chatFp);
  const pfps = list.map((p) => FP.postFingerprint(p.sender || null, p.at || null, p.orig || p.text));
  const known = fpOk ? (await Decisions.list(pool, broker.agency_id, chatFp).catch(() => ({ decisions: {} }))).decisions : {};
  const remembered = {};
  pfps.forEach((fp, i) => { if (known[fp]) remembered[i + 1] = known[fp].outcome; });
  const discarded = Object.keys(remembered).filter((r) => remembered[r] === "discarded").map(Number);
  const id = await Imports.savePlan(
    pool,
    broker,
    "excel",
    { ...plan, rows, columns, skipped: [], source: "chat", posts: list.map((p, i) => ({ sender: p.sender || null, at: p.at || null, text: String(p.text || '').slice(0, 4000), orig: String(p.orig || '').slice(0, 4000), pfp: pfps[i] })), chat_fp: fpOk ? chatFp : null, remembered, ...(discarded.length ? { discarded } : {}), parsed: first, photos: {}, newPlaces },
    { filename }
  );
  await ParseLog.posts(pool, broker, id, logs);
  // What each post turned out to be (new, changed, unchanged, invalid…): the browser skips the photos of units the save will not touch.
  const kinds = Object.fromEntries(plan.items.map((i) => [i.row, i.kind]));
  return { id, posts: list.length, ai: aiCalls, aiBlocked: blocked, counts: plan.counts, kinds, remembered };
}

// ---- The app's per-post plan (POST /units/chat-plan): the same planner, one post at a time, answered in the add-unit form's names.
const MAX_APP_POSTS = 60;
const Form = require("../web/forms/unitForm");
const Store = require("../lib/listingStore");

// Form fields the app may overlay on a stored unit. Never the unit's market, readiness, features, notes, summary, plans, owner phone or code.
const NEVER_OVERLAY = /^(market|is_ready|feature|features_other|notes|clean_summary|owner_phone|code|pin|cash_price|maintenance_terms|maintenance_pct|plan_.*)$/;
// describeChanges fields that belong to those same values.
const NEVER_CHANGE = new Set(["market", "is_ready", "feature_keys", "features_other", "details.notes", "details.clean_summary", "details.summary_en", "payment_terms", "details.owner_phone"]);
// Form field → sheet cell, for what the person edited in the app before asking (a value that differs from the reader's own).
const FORM_TO_CELL = { listing_type: "listing_type", property_type: "property_type", compound: "compound", price_value: "price_value", area_value: "area_value", land_area: "land_area", bedrooms: "bedrooms", bathrooms: "bathrooms", floor_level: "floor", finishing: "finishing", furnishing: "furnishing", down_payment_value: "down_payment_value", remaining_amount: "remaining_amount", installment_value: "installment_value", owner_name: "owner_name" };

function cellsOfPost(post, places, lang) {
  const cells = { ...ChatListing.parsePost(post.text, places, { at: post.at }).cells };
  const fields = post.fields && typeof post.fields === "object" ? post.fields : {};
  const base = Form.formFromUnit(Imports.fieldsOfCells(cells, lang));
  for (const [f, c] of Object.entries(FORM_TO_CELL)) {
    const v = fields[f] === undefined || fields[f] === null ? "" : String(fields[f]).trim();
    if (v && v !== String(base[f] ?? "")) cells[c] = v;
  }
  const code = String(fields.code || "").trim();
  if (code) cells.code = code;
  return cells;
}

const digits = (s) => String(s || "").replace(/\D/g, "");
const unitRef = (ex) => ({ code: ex.code, version: ex.version, updated_at: ex.updated_at || null });

/** What one post would do to the broker's own inventory, as the app shows it. Nothing is written. */
async function planOnePost(pool, broker, post, places, lang) {
  const id = post && post.id !== undefined ? post.id : null;
  const answer = { id, kind: "invalid", code: null, existing: null, changes: [], patch: {}, errors: [] };
  const text = String(post?.text || "").slice(0, 4000);
  const cells = cellsOfPost({ ...post, text }, places, lang);
  const { items } = await Imports.planExcel(pool, broker, { rows: [{ rowNumber: 1, cells }], skipped: [] }, { lang, source: "chat" });
  const item = items[0];
  answer.code = item.code || null;
  if (item.kind === "invalid") { answer.errors = item.reasons || []; return answer; }
  if (item.kind === "forbidden") return { ...answer, kind: "forbidden", errors: item.reasons || [] };
  if (item.kind === "new") return { ...answer, kind: "new", fields: Form.formFromUnit(item.fields) };

  // changed / unchanged / review: an existing unit of the agency (review: a different unit holds the code, or the post looks like one).
  const merge = item.merge;
  const ex = await Store.findByCode(pool, broker.agency_id, String(merge ? merge.code : item.code));
  if (!ex) return { ...answer, errors: ["not_found"] };
  answer.code = ex.code;
  answer.existing = unitRef(ex);
  if (item.code_taken) return { ...answer, kind: "other_unit" };

  const cols = merge ? merge.patch : item.patch || {};
  const was = Form.formFromUnit(ex);
  const now = Form.formFromUnit({ ...ex, ...cols });
  const patch = {};
  for (const k of Object.keys(now)) if (!NEVER_OVERLAY.test(k) && JSON.stringify(now[k]) !== JSON.stringify(was[k])) patch[k] = now[k];
  // The owner phone is only ever filled in when none is stored, and only if the post's own text holds it.
  const newPhone = cols.details?.owner_phone;
  if (!String(ex.details?.owner_phone || "").trim() && newPhone && digits(text).includes(digits(newPhone))) patch.owner_phone = String(newPhone);
  const keep = (c) => !NEVER_CHANGE.has(c.field) || (c.field === "details.owner_phone" && "owner_phone" in patch);
  const ar = Imports.describeChanges(ex, cols, "ar").filter(keep);
  const en = Imports.describeChanges(ex, cols, "en").filter(keep);
  answer.changes = ar
    .map((c, n) => ({ field: c.field, from: c.from, to: c.to, from_ar: c.from, from_en: en[n]?.from ?? c.from, to_ar: c.to, to_en: en[n]?.to ?? c.to }))
    .filter((c) => c.field !== "delivery" || "delivery_year" in patch || "delivery_quarter" in patch);
  if (!Object.keys(patch).length) return { ...answer, kind: "unchanged", changes: [] };
  if (post.at && ex.updated_at && new Date(ex.updated_at) > new Date(post.at)) return { ...answer, kind: "older" };
  answer.kind = "update";
  answer.patch = patch;
  const noteNow = String(cols.details?.notes || "");
  const noteWas = String(ex.details?.notes || "");
  if (noteNow && noteNow !== noteWas) answer.notes_append = (noteNow.startsWith(noteWas) ? noteNow.slice(noteWas.length) : noteNow).replace(/^[\s·|-]+/, "").trim();
  return answer;
}

/** @returns {Promise<{ posts: Array<{ id, kind, code, existing, changes, patch, errors }> }>} one answer per post, in order */
async function planPosts(pool, broker, posts, { lang = "ar" } = {}) {
  const list = (Array.isArray(posts) ? posts : []).slice(0, MAX_APP_POSTS);
  const places = await loadPlaces(pool).catch(() => null);
  const out = [];
  for (const post of list) {
    try {
      out.push(await planOnePost(pool, broker, post || {}, places, lang));
    } catch {
      out.push({ id: post && post.id !== undefined ? post.id : null, kind: "invalid", code: null, existing: null, changes: [], patch: {}, errors: ["unreadable"] });
    }
  }
  return { posts: out };
}

module.exports = { planChat, planPosts, loadPlaces, MAX_POSTS, MAX_APP_POSTS };
