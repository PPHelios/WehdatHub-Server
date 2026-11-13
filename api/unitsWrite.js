// api/unitsWrite.js — Add a unit from the app: fill the fields from a description or a voice note (extract), check them
// (review: the same field table as the website and WhatsApp, domain/fieldRules.js), then save (insert-only, duplicate check,
// plan limit). The fields use the website form's names (web/forms/unitForm.js), so both screens share one set of rules.
"use strict";

const L = require("../lib/listing");
const AI = require("../lib/ai");
const AiBlock = require("../lib/aiBlock");
const Store = require("../lib/listingStore");
const Edits = require("../lib/edits");
const Authz = require("../lib/authz");
const Rights = require("../services/unitRights");
const Supabase = require("../lib/supabase");
const RateLimit = require("../lib/rateLimit");
const { normalizeImageBuffer, MAX_PHOTOS } = require("../lib/images");
const { logOperation } = require("../lib/db");
const Rules = require("../domain/fieldRules");
const Plans = require("../domain/plans");
const FormChecks = require("../lib/formChecks");
const Form = require("../web/forms/unitForm");
const { uploads, PHOTO, VOICE } = require("../web/uploads");
const SaveKeys = require("../lib/saveKeys");
const Uploads = require("../lib/unitUploads");
const UnitDelete = require("../services/unitDelete");
const Leases = require("../services/leases");
const Privacy = require("../services/unitPrivacy");
const Catalogue = require("../services/catalogue");

const MAX_DESCRIBE = 4000;
const L10n = (lang, ar, en) => (lang === "en" ? en : ar);
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

/** The body of a repeated create: the unit the first try saved, with its photo count. */
async function repeatBody(pool, broker, code) {
  const { rows } = await pool.query("SELECT count(li.*)::int AS n FROM listings l LEFT JOIN listing_images li ON li.listing_id = l.id WHERE l.agency_id = $1 AND l.code = $2", [broker.agency_id, code]);
  return { code, photos: rows[0] ? rows[0].n : 0, photosFailed: 0, repeat: true };
}

function register(api, { pool }) {
  const upload = uploads([PHOTO, VOICE]);

  // Fill the fields from a typed description (a shared WhatsApp message) and/or a voice note. Nothing is saved.
  // Lifecycle from the unit page: active / sold / archived, delete (kept 10 days) and restore. Same rules as the website.
  const unitFor = async (req, res) => {
    const b = req.session.broker;
    const listing = await Store.findByCode(pool, b.agency_id, req.params.code);
    if (!listing || !Authz.canView(b, listing)) {
      res.status(404).json({ error: "not_found" });
      return null;
    }
    return listing;
  };
  api.post("/units/:code/status", async (req, res) => {
    const b = req.session.broker;
    const listing = await unitFor(req, res);
    if (!listing) return;
    const status = String((req.body || {}).status || "");
    if (!["active", "sold", "archived"].includes(status)) return res.status(422).json({ error: "unknown_status" });
    if (listing.status === "deleted") return res.status(422).json({ error: "deleted" });
    if (!Authz.canEdit(b, listing) || !(await Rights.mayWrite(pool, b))) return res.status(403).json({ error: "forbidden" });
    if (listing.status !== status) {
      const out = await Store.applyListingPatch(pool, b, { listing, patch: { status } });
      if (out.conflict) return res.status(409).json({ error: "conflict" });
      logOperation(pool, { agency_id: b.agency_id, broker_id: b.id, listing_code: listing.code, operation_type: `listing_status_${status}`, metadata: { from: listing.status } });
    }
    return res.json({ ok: true, status });
  });
  api.post("/units/:code/delete", async (req, res) => {
    const b = req.session.broker;
    const listing = await unitFor(req, res);
    if (!listing) return;
    const out = await UnitDelete.softDelete(pool, b, listing.id);
    if (out.error) return res.status(out.error === "forbidden" ? 403 : 422).json({ error: out.error });
    logOperation(pool, { agency_id: b.agency_id, broker_id: b.id, listing_code: listing.code, operation_type: "unit_soft_delete", metadata: {} });
    return res.json({ ok: true });
  });
  api.post("/units/:code/restore", async (req, res) => {
    const b = req.session.broker;
    const listing = await Store.findByCode(pool, b.agency_id, req.params.code);
    if (!listing) return res.status(404).json({ error: "not_found" });
    const out = await UnitDelete.restore(pool, b, listing.id);
    if (out.error) return res.status(out.error === "forbidden" ? 403 : 422).json({ error: out.error });
    logOperation(pool, { agency_id: b.agency_id, broker_id: b.id, listing_code: listing.code, operation_type: "unit_restore", metadata: {} });
    return res.json({ ok: true, code: out.code });
  });

  // Lease of a rented unit and the agency-only details (pin, unit number, address). Same services as the website.
  api.get("/units/:code/lease", async (req, res) => {
    const listing = await unitFor(req, res);
    if (!listing) return;
    const l = await Leases.forListing(pool, listing);
    return res.json({ rent: listing.listing_type === "rent", lease: l ? { startDate: String(l.start_date).slice(0, 10), months: l.months, rent: l.rent, increasePct: l.increase_pct, tenantName: l.tenant_name, remind: !!l.remind, done: !!l.done_at } : null });
  });
  api.post("/units/:code/lease", async (req, res) => {
    const b = req.session.broker;
    const listing = await unitFor(req, res);
    if (!listing) return;
    const body = req.body || {};
    const out = body.remove ? await Leases.remove(pool, b, listing) : await Leases.save(pool, b, listing, { start_date: body.startDate, months: body.months, rent: body.rent, increase_pct: body.increasePct, tenant_name: body.tenantName, remind: body.remind ? "1" : "" });
    if (out.error) return res.status(out.error === "forbidden" ? 403 : 422).json({ error: out.error });
    return res.json({ ok: true });
  });
  api.post("/units/:code/private", async (req, res) => {
    const b = req.session.broker;
    const listing = await unitFor(req, res);
    if (!listing) return;
    if (!Authz.canEdit(b, listing)) return res.status(403).json({ error: "forbidden" });
    const body = req.body || {};
    const raw = String(body.pin || "").trim();
    const pin = raw ? Privacy.parsePin(raw) : null;
    if (raw && !pin) return res.status(422).json({ error: "bad_pin" });
    await Privacy.setPin(pool, b, listing, pin, { source: "app" });
    const clean = (v, n) => String(v || "").trim().slice(0, n) || null;
    await pool.query(
      `UPDATE listings SET details = (details - 'unit_no' - 'address') || jsonb_strip_nulls(jsonb_build_object('unit_no', $3::text, 'address', $4::text)), updated_at = now() WHERE id = $1 AND agency_id = $2`,
      [listing.id, b.agency_id, clean(body.unitNo, 40), clean(body.address, 200)]
    );
    return res.json({ ok: true });
  });

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
    const fields = fieldsOf(req.body);
    // An edit (code given): the unit as it is now, so the review lists what would change.
    const existing = req.body?.code ? await Store.findByCode(pool, broker.agency_id, String(req.body.code)) : null;
    const { ev } = evaluate(fields, lang, photoCount);
    // What the save also refuses (owner phone and name; a compound that is not on the list) is listed here too.
    const blockers = [...blockersOf(ev), ...FormChecks.ownerBlockers(ev.listing, fields, lang, { isNew: !existing }).map((b) => ({ field: b.field, label: b.label }))];
    if (String(ev.listing.compound || "").trim() && !(fields.compound_new === true || fields.compound_new === "1") && (!existing || existing.compound !== ev.listing.compound)) {
      const r = await require("../services/compoundResolve").resolve(pool, ev.listing);
      if (r.compound_state === "needs_fix") blockers.push({ field: "compound", label: L10n(lang, "الكمبوند مش في القائمة. اختاره من القائمة أو علّم \"مش في القائمة\".", "This compound is not on the list. Pick it, or mark it as new.") });
    }
    const ok = blockers.length === 0;
    const duplicate = ok ? await Store.findDuplicate(pool, broker.agency_id, ev.listing, { excludeId: existing?.id }) : null;
    return res.json({ ok, blockers, warnings: warningsOf(ev, lang), duplicate: duplicate || null, changes: FormChecks.changesOf(existing, ev.listing) });
  });

  // The unit's fields as the form names them, for the edit screen. Whoever may edit the unit may open this.
  api.get("/units/:code/edit", async (req, res) => {
    const { broker } = req.session;
    if (!(await Rights.mayWrite(pool, broker))) return res.status(403).json({ error: "writes_off" });
    const listing = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!listing) return res.status(404).json({ error: "not_found" });
    if (!Authz.canEdit(broker, listing)) return res.status(403).json({ error: "forbidden" });
    return res.json({ code: listing.code, version: listing.version, fields: Form.formFromUnit(listing) });
  });

  // Save changes to one unit: the version the screen was opened at must still be current (409 otherwise). Photos are not
  // changed here.
  api.post("/units/:code/edit", async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    if (!(await Rights.mayWrite(pool, broker))) return res.status(403).json({ error: "writes_off" });
    const gate = await RateLimit.hit(pool, `crm_write:broker:${broker.id}`, RateLimit.LIMITS.crmWriteBroker);
    if (!gate.allowed) return res.status(429).set("Retry-After", String(gate.retryAfterSec)).json({ error: "rate_limited" });
    const expectedVersion = Number(req.body && req.body.version);
    if (!Number.isInteger(expectedVersion)) return res.status(400).json({ error: "version_required" });
    const form = Form.unitFromForm(fieldsOf(req.body));
    const saveKey = SaveKeys.keyOf(req.body);
    const t0 = Date.now();
    const out = await Edits.withCodeLock(pool, broker.agency_id, req.params.code, async (client) => {
      const listing = await Store.findByCode(client, broker.agency_id, req.params.code, { forUpdate: true });
      if (!listing) return { missing: true };
      if (!Authz.canEdit(broker, listing)) return { forbidden: true };
      // The same save sent again (a lost answer, the 60-second check's Retry): the first result, never a second change.
      const key = await SaveKeys.claim(client, broker.agency_id, saveKey, "edit");
      if (!key.first) return { rollback: true, repeat: listing };
      const photoCount = (await client.query("SELECT count(*)::int AS n FROM listing_images WHERE listing_id = $1", [listing.id])).rows[0].n;
      const ev = Rules.evaluate(Form.composeFromForm({ existing: listing, form, lang }), { lang, photoCount });
      if (!ev.ok) return { rollback: true, listing, ev };
      const patch = Edits.diffPatch(listing, ev.listing);
      const res2 = await Store.applyListingPatch(client, broker, { listing, patch, expectedVersion });
      if (res2.conflict) return { rollback: true, conflict: true };
      if (res2.forbidden) return { rollback: true, forbidden: true };
      await SaveKeys.attach(client, broker.agency_id, saveKey, res2.listing.code);
      return { saved: res2.listing, columns: Object.keys(patch) };
    });
    if (out.repeat) return res.json({ code: out.repeat.code, version: out.repeat.version, repeat: true });
    if (out.missing) return res.status(404).json({ error: "not_found" });
    if (out.forbidden) return res.status(403).json({ error: "forbidden" });
    if (out.conflict) return res.status(409).json({ error: "conflict" });
    if (!out.saved) return res.status(422).json({ error: "incomplete", blockers: blockersOf(out.ev) });
    require("../lib/db").logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, listing_code: out.saved.code, operation_type: "app_unit_edit", total_duration_ms: Date.now() - t0, metadata: { columns: out.columns, save_key: Boolean(saveKey) } });
    return res.json({ code: out.saved.code, version: out.saved.version });
  });

  // Photos of an existing unit: add new ones (multipart "photos"), remove some (JSON array "remove" of image ids) and set the
  // order (JSON array "order" of image ids, first is the cover; new photos follow). Same limit as the website.
  api.post("/units/:code/photos", upload, async (req, res) => {
    const { broker } = req.session;
    if (!(await Rights.mayWrite(pool, broker))) return res.status(403).json({ error: "writes_off" });
    const gate = await RateLimit.hit(pool, `crm_write:broker:${broker.id}`, RateLimit.LIMITS.crmWriteBroker);
    if (!gate.allowed) return res.status(429).set("Retry-After", String(gate.retryAfterSec)).json({ error: "rate_limited" });
    const ids = (raw) => {
      try {
        const v = typeof raw === "string" ? JSON.parse(raw) : raw;
        return (Array.isArray(v) ? v : []).filter((id) => /^[0-9a-f-]{36}$/.test(String(id))).map(String);
      } catch {
        return [];
      }
    };
    const removeIds = ids(req.body && req.body.remove);
    const order = ids(req.body && req.body.order).filter((id) => !removeIds.includes(id));
    const files = filesOf(req, "photos").slice(0, MAX_PHOTOS);
    const keys = Uploads.keysOf(req.body).slice(0, Math.max(0, MAX_PHOTOS - files.length));
    const staged = await Uploads.verify(pool, broker, keys);
    if (staged.missing.length) return res.status(422).json({ error: "photo_missing", keys: staged.missing });
    const photos = await storePhotos(broker, files);
    const out = await Edits.withCodeLock(pool, broker.agency_id, req.params.code, async (client) => {
      const listing = await Store.findByCode(client, broker.agency_id, req.params.code, { forUpdate: true });
      if (!listing) return { rollback: true, missing: true };
      if (!Authz.canEdit(broker, listing)) return { rollback: true, forbidden: true };
      if (!(await Uploads.attach(client, broker, keys))) return { rollback: true, photosUsed: true };
      const left = (await client.query("SELECT count(*)::int AS n FROM listing_images WHERE listing_id = $1 AND NOT (id = ANY($2::uuid[]))", [listing.id, removeIds])).rows[0].n;
      if (left + photos.urls.length + keys.length > MAX_PHOTOS) return { rollback: true, tooMany: true };
      const removed = await Store.removePhotos(client, listing, removeIds);
      await Store.addPhotos(client, listing, [...staged.paths, ...photos.urls]);
      if (order.length > 1) await Store.reorderPhotos(client, listing, order);
      await client.query("UPDATE listings SET flyer_cache = '{}'::jsonb, updated_at = now() WHERE id = $1", [listing.id]);
      const images = (await client.query("SELECT id, url, position FROM listing_images WHERE listing_id = $1 ORDER BY position", [listing.id])).rows;
      return { removed, images, listing };
    });
    if (!out.images) Supabase.deleteStorageFiles(photos.urls).catch(() => {});
    if (out.missing) return res.status(404).json({ error: "not_found" });
    if (out.forbidden) return res.status(403).json({ error: "forbidden" });
    if (out.photosUsed) return res.status(409).json({ error: "photos_used" });
    if (out.tooMany) return res.status(422).json({ error: "too_many_photos", max: MAX_PHOTOS });
    if (out.removed.length) Supabase.deleteStorageFiles(out.removed).catch(() => {});
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, listing_code: out.listing.code, operation_type: "app_unit_photos", metadata: { added: photos.urls.length, removed: out.removed.length } });
    return res.json({ images: out.images.map((i) => ({ id: i.id, url: Supabase.photoUrl(i.url), position: i.position })), failed: photos.failed });
  });

  // One-time upload links so the app sends each photo straight to storage (never through this server). Then create or add photos
  // with the returned `key`s as `photo_keys`.
  api.post("/units/photo-upload", async (req, res) => {
    const { broker } = req.session;
    if (!(await Rights.mayWrite(pool, broker))) return res.status(403).json({ error: "writes_off" });
    const out = await Uploads.sign(pool, broker, (req.body || {}).count, "app");
    res.set("Cache-Control", "no-store");
    if (out.limited) return res.status(429).json({ error: "rate_limited" });
    if (out.failed) return res.status(503).json({ error: "storage_unavailable" });
    return res.json({ ...out, expires_in: 7200 });
  });

  // Save: the field table must pass; insert-only (a used code is refused, never overwritten).
  api.post("/units", upload, async (req, res) => {
    if (!(await Rights.mayWrite(pool, req.session.broker))) return res.status(403).json({ error: "writes_off" });
    const lang = langOf(req);
    const { broker } = req.session;
    const gate = await RateLimit.hit(pool, `crm_write:broker:${broker.id}`, RateLimit.LIMITS.crmWriteBroker);
    if (!gate.allowed) return res.status(429).set("Retry-After", String(gate.retryAfterSec)).json({ error: "rate_limited" });
    const fields = fieldsOf(req.body);
    const t0 = Date.now();
    const saveKey = SaveKeys.keyOf(req.body);
    const prior = await SaveKeys.lookup(pool, broker.agency_id, saveKey);
    if (prior) return res.status(201).json(await repeatBody(pool, broker, prior));
    const files = filesOf(req, "photos").slice(0, MAX_PHOTOS);
    const keys = Uploads.keysOf(req.body).slice(0, Math.max(0, MAX_PHOTOS - files.length));
    const { form, ev } = evaluate(fields, lang, files.length + keys.length);
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
      // The names it looks like are offered ("did you mean"); the broker picks one or marks the compound as new.
      if (r.compound_state === "needs_fix") return res.status(422).json({ error: "compound_unknown", suggestions: await require("../services/compoundResolve").suggest(pool, ev.listing.compound, 3) });
    }
    if (!(fields.force === true || fields.force === "1")) {
      const duplicate = await Store.findDuplicate(pool, broker.agency_id, ev.listing);
      if (duplicate) return res.status(409).json({ error: "duplicate", duplicate });
    }
    const staged = await Uploads.verify(pool, broker, keys);
    if (staged.missing.length) return res.status(422).json({ error: "photo_missing", keys: staged.missing });
    const tPhotos = Date.now();
    const photos = await storePhotos(broker, files);
    const photoMs = Date.now() - tPhotos;
    const tDb = Date.now();
    const client = await pool.connect();
    let result;
    let repeat = null;
    let photosUsed = false;
    try {
      await client.query("BEGIN");
      const key = await SaveKeys.claim(client, broker.agency_id, saveKey, "create");
      if (!key.first) {
        repeat = key;
        await client.query("ROLLBACK");
      } else result = await Store.createListing(client, broker, { fields: ev.listing, code: form.code, lang });
      if (result && result.listing) {
        await SaveKeys.attach(client, broker.agency_id, saveKey, result.listing.code);
        if (!(await Uploads.attach(client, broker, keys))) photosUsed = true;
        const added = await Store.addPhotos(client, result.listing, photosUsed ? [] : [...staged.paths, ...photos.urls]);
        // The broker ordered the photos by hand (drag and drop in the app): AI ordering is skipped for this unit (saves AI credits).
        if (!(fields.photo_ai === true || fields.photo_ai === "1") && added.length) await Store.reorderPhotos(client, result.listing, added.map((r) => r.id), { force: true });
      }
      if (!repeat) await client.query(result.listing && !photosUsed ? "COMMIT" : "ROLLBACK");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      Supabase.deleteStorageFiles(photos.urls).catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    if (photosUsed) {
      Supabase.deleteStorageFiles(photos.urls).catch(() => {});
      return res.status(409).json({ error: "photos_used" });
    }
    if (repeat) {
      Supabase.deleteStorageFiles(photos.urls).catch(() => {});
      return res.status(201).json(await repeatBody(pool, broker, repeat.code));
    }
    if (!result.listing) {
      Supabase.deleteStorageFiles(photos.urls).catch(() => {});
      if (result.limit) return res.status(403).json({ error: "plan_limit", message: Plans.unitLimitText(result.limit, lang) });
      if (result.owner_required) return res.status(422).json({ error: "owner_required" });
      if (result.conflict) return res.status(409).json({ error: "code_used", code: result.code });
      return res.status(422).json({ error: "not_saved" });
    }
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, listing_code: result.listing.code, operation_type: "app_unit_create", total_duration_ms: Date.now() - t0, storage_upload_ms: photoMs, db_ms: Date.now() - tDb, metadata: { photos: photos.urls.length + staged.paths.length, direct: staged.paths.length, photo_failures: photos.failed, save_key: Boolean(saveKey) } });
    return res.status(201).json({ code: result.listing.code, photos: photos.urls.length + staged.paths.length, photosFailed: photos.failed });
  });
}

module.exports = { register };
