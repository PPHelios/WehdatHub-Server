// api/unitsWrite.js — Add a unit from the app: fill the fields from a description or a voice note (extract), check them
// (review: the same field table as the website and WhatsApp, domain/fieldRules.js), then save (insert-only, duplicate check,
// plan limit). The fields use the website form's names (web/forms/unitForm.js), so both screens share one set of rules.
"use strict";

const L = require("../lib/listing");
const AI = require("../lib/ai");
const AiBlock = require("../lib/aiBlock");
const Store = require("../lib/listingStore");
const Rights = require("../services/unitRights");
const Authz = require("../lib/authz");
const Supabase = require("../lib/supabase");
const RateLimit = require("../lib/rateLimit");
const { normalizeImageBuffer, MAX_PHOTOS } = require("../lib/images");
const { logOperation } = require("../lib/db");
const Rules = require("../domain/fieldRules");
const Plans = require("../domain/plans");
const Form = require("../web/forms/unitForm");
const { uploads, PHOTO, VOICE } = require("../web/uploads");

const MAX_DESCRIBE = 4000;
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const filesOf = (req, name) => (req.files && req.files[name]) || [];

/** The `fields` the app sends: a JSON object (or a JSON string inside a multipart body) of website-form names. */
function fieldsOf(body) {
  const raw = body?.fields;
  if (raw && typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(String(raw || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function evaluate(fields, lang, photoCount) {
  const form = Form.unitFromForm(fields);
  const ev = Rules.evaluate(Form.composeFromForm({ existing: null, form, lang }), { lang, photoCount });
  return { form, ev };
}
const blockersOf = (ev) => ev.blockers.map((b) => ({ field: b.field, label: b.label }));
const warningsOf = (ev, lang) => ev.warnings.map((w) => ({ field: w.field, text: Rules.warningLine(w, lang) }));

async function storePhotos(broker, files) {
  const urls = [];
  let failed = 0;
  for (let i = 0; i < files.length; i++) {
    try {
      const jpeg = await normalizeImageBuffer(files[i].buffer);
      const url = await Supabase.uploadListingImage(broker.agency_id, `listings/${broker.agency_id}/app/${broker.id}/${Date.now()}_${i}.jpg`, jpeg);
      if (url) urls.push(url);
      else failed++;
    } catch {
      failed++;
    }
  }
  return { urls, failed };
}

function register(api, { pool }) {
  const upload = uploads([PHOTO, VOICE]);

  // Fill the fields from a typed description (a shared WhatsApp message) and/or a voice note. Nothing is saved.
  api.post("/units/extract", upload, async (req, res) => {
    if (!(await Rights.mayWrite(pool, req.session.broker))) return res.status(403).json({ error: "writes_off" });
    const lang = langOf(req);
    const { broker } = req.session;
    const text = String(req.body?.describe || "").trim().slice(0, MAX_DESCRIBE);
    const voice = filesOf(req, "voice").map((f) => ({ buffer: f.buffer, mimeType: f.mimetype.split(";")[0] }));
    if (!text && !voice.length) return res.status(400).json({ error: "nothing_to_read" });
    const gate = await RateLimit.hit(pool, `extract:broker:${broker.id}`, RateLimit.LIMITS.extractBroker);
    if (!gate.allowed) return res.status(429).set("Retry-After", String(gate.retryAfterSec)).json({ error: "rate_limited" });
    try {
      const base = Form.composeFromForm({ existing: null, form: Form.unitFromForm(fieldsOf(req.body)), lang });
      const extracted = await L.extractPropertyDetails(AI, { texts: text ? [text] : [], voice, lang, ctx: { pool, broker, agency: req.session.agency, lang } });
      const merged = L.composeFields({ existing: base, draft: extracted.fields, lang });
      logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "app_unit_extract", metadata: { voice: voice.length, text: Boolean(text) } });
      return res.json({ fields: { ...Form.formFromUnit(merged), code: extracted.fields.code || "" } });
    } catch (err) {
      const why = AiBlock.kindOf(err);
      if (why !== "ai") return res.status(402).json({ error: "ai_blocked", message: AiBlock.text(why, lang, { owner: Authz.isAgencyOwner(broker) }), fallback: true });
      return res.status(503).json({ error: "ai_unavailable", fallback: true });
    }
  });

  // What is still missing, warnings, and a duplicate, without saving.
  api.post("/units/review", async (req, res) => {
    if (!(await Rights.mayWrite(pool, req.session.broker))) return res.status(403).json({ error: "writes_off" });
    const lang = langOf(req);
    const { broker } = req.session;
    const photoCount = Math.max(0, Math.min(parseInt(req.body?.photoCount, 10) || 0, MAX_PHOTOS));
    const { ev } = evaluate(fieldsOf(req.body), lang, photoCount);
    const duplicate = ev.ok ? await Store.findDuplicate(pool, broker.agency_id, ev.listing) : null;
    return res.json({ ok: ev.ok, blockers: blockersOf(ev), warnings: warningsOf(ev, lang), duplicate: duplicate || null });
  });

  // Save: the field table must pass; insert-only (a used code is refused, never overwritten).
  api.post("/units", upload, async (req, res) => {
    if (!(await Rights.mayWrite(pool, req.session.broker))) return res.status(403).json({ error: "writes_off" });
    const lang = langOf(req);
    const { broker } = req.session;
    const gate = await RateLimit.hit(pool, `crm_write:broker:${broker.id}`, RateLimit.LIMITS.crmWriteBroker);
    if (!gate.allowed) return res.status(429).set("Retry-After", String(gate.retryAfterSec)).json({ error: "rate_limited" });
    const fields = fieldsOf(req.body);
    const files = filesOf(req, "photos").slice(0, MAX_PHOTOS);
    const { form, ev } = evaluate(fields, lang, files.length);
    if (!ev.ok) return res.status(422).json({ error: "incomplete", blockers: blockersOf(ev) });
    // An owner phone with no name is refused unless the broker says to use the phone as the name.
    const d = ev.listing.details || {};
    if (String(d.owner_phone || "").trim() && !String(d.owner_name || "").trim()) {
      if (fields.owner_name_from_phone === true || fields.owner_name_from_phone === "1") d.owner_name = require("../domain/phone").displayPhone(d.owner_phone);
      else return res.status(422).json({ error: "owner_name_required" });
    }
    // The compound must be on the approved list unless the broker says it is new (kept as pending for review).
    if (String(ev.listing.compound || "").trim() && !(fields.compound_new === true || fields.compound_new === "1")) {
      const r = await require("../services/compoundResolve").resolve(pool, ev.listing);
      if (r.compound_state === "needs_fix") return res.status(422).json({ error: "compound_unknown" });
    }
    if (!(fields.force === true || fields.force === "1")) {
      const duplicate = await Store.findDuplicate(pool, broker.agency_id, ev.listing);
      if (duplicate) return res.status(409).json({ error: "duplicate", duplicate });
    }
    const photos = await storePhotos(broker, files);
    const client = await pool.connect();
    let result;
    try {
      await client.query("BEGIN");
      result = await Store.createListing(client, broker, { fields: ev.listing, code: form.code, lang });
      if (result.listing) {
        const added = await Store.addPhotos(client, result.listing, photos.urls);
        // The broker ordered the photos by hand (drag and drop in the app): AI ordering is skipped for this unit (saves AI credits).
        if (!(fields.photo_ai === true || fields.photo_ai === "1") && added.length) await Store.reorderPhotos(client, result.listing, added.map((r) => r.id), { force: true });
      }
      await client.query(result.listing ? "COMMIT" : "ROLLBACK");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      Supabase.deleteStorageFiles(photos.urls).catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    if (!result.listing) {
      Supabase.deleteStorageFiles(photos.urls).catch(() => {});
      if (result.limit) return res.status(403).json({ error: "plan_limit", message: Plans.unitLimitText(result.limit, lang) });
      if (result.owner_required) return res.status(422).json({ error: "owner_required" });
      if (result.conflict) return res.status(409).json({ error: "code_used", code: result.code });
      return res.status(422).json({ error: "not_saved" });
    }
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, listing_code: result.listing.code, operation_type: "app_unit_create", metadata: { photos: photos.urls.length, photo_failures: photos.failed } });
    return res.status(201).json({ code: result.listing.code, photos: photos.urls.length, photosFailed: photos.failed });
  });
}

module.exports = { register };
