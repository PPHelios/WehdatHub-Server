// web/routes/unitForm.js — Add and edit a unit on the web: the same field table (domain/fieldRules.js),
// the same AI extraction (lib/listing.js, text or a voice note), the same insert-only create and the
// same optimistic-locked patch (lib/listingStore.js) as WhatsApp. Photos are normalized in memory.
"use strict";

const L = require("../../lib/listing");
const AI = require("../../lib/ai");
const AiBlock = require("../../lib/aiBlock");
const Store = require("../../lib/listingStore");
const Edits = require("../../lib/edits");
const Authz = require("../../lib/authz");
const Supabase = require("../../lib/supabase");
const RateLimit = require("../../lib/rateLimit");
const { normalizeImageBuffer, MAX_PHOTOS } = require("../../lib/images");
const { logOperation } = require("../../lib/db");
const Rules = require("../../domain/fieldRules");
const Card = require("../../domain/leadCard");
const Leads = require("../../services/leads");
const Privacy = require("../../services/unitPrivacy");
const Leases = require("../../services/leases");
const Rights = require("../../services/unitRights");
const Plans = require("../../domain/plans");
const Form = require("../forms/unitForm");
const Session = require("../session");
const { uploads, PHOTO, VOICE } = require("../uploads");
const { html } = require("../html");
const { unitForm, reviewPanel } = require("../views/unitForm");
const { placeList } = require("../views/searchForm");
const { imagesOf } = require("./units");

const L10n = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const upload = uploads([PHOTO, VOICE]);

for (const re of [/^\/units\/new$/, /^\/units\/extract$/, /^\/units\/review$/, /^\/units\/step-check$/, /^\/units\/[^/]+\/edit$/]) Session.allowMultipart(re);

const filesOf = (req, name) => (req.files && req.files[name]) || [];
const ctxOf = (pool, req) => ({ pool, broker: req.session.broker, agency: req.session.agency, lang: langOf(req) });

/**
 * Every refused add or edit leaves a row in operation_logs (status error, error_code = the reason) and answers with a
 * readable text. The reason and the blocked field names are kept; no unit values are logged.
 */
function traceRefusal(pool, req, { reason, listingCode = null, blockers = [] }) {
  const { broker } = req.session;
  req.res.locals.failureTraced = true; // the shared 4xx log (lib/failureLog.js) skips what is traced here
  logOperation(pool, {
    agency_id: broker.agency_id,
    broker_id: broker.id,
    listing_code: listingCode,
    operation_type: "unit_write_refused",
    status: "error",
    error_code: reason,
    metadata: { method: req.method, path: req.path.replace(/[0-9a-f-]{36}/gi, ":id"), role: broker.role || null, blockers }
  });
}

/** Normalizes and uploads photos before any transaction; returns { urls, failed }. */
async function storePhotos(broker, files) {
  const urls = [];
  let failed = 0;
  for (let i = 0; i < files.length; i++) {
    try {
      const jpeg = await normalizeImageBuffer(files[i].buffer);
      const url = await Supabase.uploadListingImage(broker.agency_id, `listings/${broker.agency_id}/web/${broker.id}/${Date.now()}_${i}.jpg`, jpeg);
      if (url) urls.push(url);
      else failed++;
    } catch {
      failed++;
    }
  }
  return { urls, failed };
}

/** The listing the edit form is about (agency-scoped, editable by this broker), or null. */
async function editable(db, broker, code, opts = {}) {
  const listing = code ? await Store.findByCode(db, broker.agency_id, code, opts) : null;
  return listing && Authz.canEdit(broker, listing) ? listing : null;
}

function evaluate({ existing, form, lang, photoCount }) {
  return Rules.evaluate(Form.composeFromForm({ existing, form, lang }), { lang, photoCount });
}

// The agency-only map pin typed in the form: a Google Maps link or coordinates; empty clears it.
const pinFrom = (body) => (String(body.pin || "").trim() ? Privacy.parsePin(body.pin) : null);
// The owner's name: a phone with no name is refused unless the broker says to use the phone as the name (saved as it is).
const ownerNameError = (listing, body, lang) => {
  const d = listing.details || {};
  if (!String(d.owner_phone || "").trim() || String(d.owner_name || "").trim()) return null;
  if (String(body.owner_name_from_phone || "") === "1") {
    d.owner_name = require("../../domain/phone").displayPhone(d.owner_phone);
    return null;
  }
  return L10n(lang, "⚠️ اكتب اسم المالك، أو علّم \"استخدم التليفون كاسم\".", "⚠️ Enter the owner's name, or tick \"Use the phone as the name\".");
};
const pinError = (body, lang) => (String(body.pin || "").trim() && !pinFrom(body) ? L10n(lang, "⛔ اللوكيشن مش واضح. الصق لينك جوجل ماب أو الإحداثيات.", "⛔ The location isn't clear. Paste a Google Maps link or the coordinates.") : null);
const savePin = (client, listing, pin) => client.query("UPDATE listings SET lat = $3, lng = $4, updated_at = now() WHERE id = $1 AND agency_id = $2", [listing.id, listing.agency_id, pin?.lat ?? null, pin?.lng ?? null]);

function register(web, { pool, page, assets }) {
  // The owner's lead code: an existing lead of this agency that this broker may see (L-0042), or an error text.
  const checkOwnerLead = async (broker, listing, lang) => {
    const raw = listing?.details?.owner_lead;
    if (!raw) return null;
    const ref = Card.parseRef(raw);
    const lead = ref ? await Leads.getLead(pool, broker, ref) : null;
    if (!lead) return L10n(lang, `⛔ كود العميل ${raw} مش موجود عندك. اكتبه زي L-0042 أو سيبه فاضي.`, `⛔ Lead code ${raw} wasn't found in your clients. Write it like L-0042 or leave it empty.`);
    listing.details.owner_lead = Card.refLabel(ref);
    return null;
  };

  // The compound must be on the approved list; a name that is not asks for a pick, or for "add as new" (kept as pending).
  const compoundError = async (client, listing, body, lang) => {
    if (!String(listing.compound || "").trim() || body.compound_new === "1") return null;
    const r = await require("../../services/compoundResolve").resolve(client, listing);
    if (r.compound_state !== "needs_fix") return null;
    // The names it looks like are offered ("did you mean"), so a spelling slip does not become a new compound.
    const like = (await require("../../services/compoundResolve").suggest(client, listing.compound, 3)).map((x) => x.name).filter(Boolean);
    const base = L10n(lang, "⛔ الكمبوند مش في القائمة. اختاره من القائمة أو علّم \"مش في القائمة\" عشان يتراجع.", "⛔ This compound is not on the list. Pick it from the list, or tick \"not in the list\" so it is reviewed.");
    return like.length ? `${base} ${L10n(lang, "قصدك:", "Did you mean:")} ${like.join(" / ")}` : base;
  };
  const formPage = async (req, res, opts, status = 200) => {
    const lang = langOf(req);
    const approvedPlaces = await pool.query("SELECT name_en, name_ar FROM map_places WHERE approved ORDER BY name_en").then((r) => r.rows).catch(() => []);
    const leadChoices = await Leases.tenantChoices(pool, req.session.broker).catch(() => []);
    const areas = await require("../../services/areas").approvedAreas(pool).catch(() => []);
    const edit = opts.mode === "edit";
    return page(
      req,
      res,
      {
        title: edit ? `${L10n(lang, "تعديل", "Edit")} ${opts.code}` : L10n(lang, "إضافة وحدة", "Add a unit"),
        nav: edit ? "units" : "add",
        body: html`<h1>${edit ? `✏️ ${L10n(lang, "تعديل", "Edit")} ${opts.code}` : `➕ ${L10n(lang, "إضافة وحدة", "Add a unit")}`}</h1>${unitForm({ lang, csrf: req.session.csrf, areas, ...opts })}${placeList()}<datalist id="approved-places">${approvedPlaces.flatMap((p) => [p.name_en, p.name_ar]).filter(Boolean).map((n) => html`<option value="${n}">`)}</datalist><datalist id="lead-codes">${leadChoices.map((c) => html`<option value="${c.label.split(" ")[0]}">${c.label}</option>`)}</datalist><script src="${assets.url("zipread.js")}"></script><script src="${assets.url("unitPhotos.js")}"></script>`
      },
      status
    );
  };

  // The agency owner can switch brokers' adding and editing off (services/unitRights.js): a clear refusal on every form route.
  const writesOff = async (req, res) => {
    if (await Rights.mayWrite(pool, req.session.broker)) return false;
    const lang = langOf(req);
    traceRefusal(pool, req, { reason: "writes_off" });
    res.status(403).type("text/plain").send(L10n(lang, "مالك الشركة قفل إضافة وتعديل الوحدات للسماسرة.", "The agency owner has switched off adding and editing units for brokers."));
    return true;
  };

  web.get("/units/new", async (req, res) => {
    if (await writesOff(req, res)) return undefined;
    return formPage(req, res, { mode: "new", values: Form.formFromUnit({ market: "resale" }) });
  });

  web.get("/units/:code/edit", async (req, res, next) => {
    if (await writesOff(req, res)) return undefined;
    const { broker } = req.session;
    const found = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!found) {
      traceRefusal(pool, req, { reason: "edit_unit_not_found", listingCode: req.params.code });
      return next();
    }
    if (!Authz.canEdit(broker, found)) {
      // Same answer as a unit that does not exist, so a VIP unit's existence is not revealed; the reason is in the log.
      traceRefusal(pool, req, { reason: found.is_private ? "edit_vip_owner_only" : "edit_role_not_allowed", listingCode: found.code });
      return res.status(404).type("text/plain").send(L10n(langOf(req), "الوحدة دي مش متاحة لحسابك.", "This unit is not available to your account."));
    }
    return formPage(req, res, { mode: "edit", code: found.code, version: found.version, values: Form.formFromUnit(found), images: await imagesOf(pool, found) });
  });

  // ✨ Fill the form from a description or a voice note (AI extraction; what the form already says is kept).
  web.post("/units/extract", upload, async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const mode = req.body.version ? "edit" : "new";
    const existing = mode === "edit" ? await editable(pool, broker, req.body.code) : null;
    if (mode === "edit" && !existing) return res.sendStatus(404);
    const form = Form.unitFromForm(req.body);
    const base = Form.composeFromForm({ existing, form, lang });
    const view = { mode, code: existing?.code, version: req.body.version, images: existing ? await imagesOf(pool, existing) : [], lang, csrf: req.session.csrf };
    const text = String(req.body.describe || "").trim().slice(0, 4000);
    const voice = filesOf(req, "voice").map((f) => ({ buffer: f.buffer, mimeType: f.mimetype.split(";")[0] }));
    if (!text && !voice.length) {
      return res.type("html").send(String(unitForm({ ...view, values: Form.formFromUnit({ ...base, code: form.code }), error: L10n(lang, "اكتب وصف أو سجّل فويس الأول.", "Type a description or record a voice note first.") })));
    }
    const gate = await RateLimit.hit(pool, `extract:broker:${broker.id}`, RateLimit.LIMITS.extractBroker);
    if (!gate.allowed) {
      return res.status(429).type("html").send(String(unitForm({ ...view, values: Form.formFromUnit({ ...base, code: form.code }), error: L10n(lang, "⏳ طلبات كتير. استنى شوية.", "⏳ Too many requests. Wait a moment.") })));
    }
    try {
      const extracted = await L.extractPropertyDetails(AI, { texts: text ? [text] : [], voice, lang, ctx: ctxOf(pool, req) });
      const merged = L.composeFields({ existing: base, draft: extracted.fields, lang });
      const code = mode === "edit" ? existing.code : form.code || extracted.fields.code || "";
      logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "web_unit_extract", metadata: { voice: voice.length, text: Boolean(text) } });
      return res.type("html").send(
        String(unitForm({ ...view, values: { ...Form.formFromUnit(merged), code }, notice: L10n(lang, "✨ اتملت البيانات من الوصف. راجعها قبل الحفظ.", "✨ Filled from your description. Check before saving.") }))
      );
    } catch (err) {
      console.warn("Web extraction failed:", err.message);
      const why = AiBlock.kindOf(err);
      return res.type("html").send(
        String(unitForm({
          ...view,
          values: Form.formFromUnit({ ...base, code: form.code }),
          error: why !== "ai"
            ? `${AiBlock.text(why, lang, { owner: Authz.isAgencyOwner(broker) })} ${L10n(lang, "املأ البيانات يدوياً هنا، من غير رصيد.", "Fill the fields by hand here, no credits needed.")}`
            : L10n(lang, "❌ تعذر قراءة الوصف حالياً. املأ البيانات يدوياً أو حاول تاني.", "❌ Could not read the description right now. Fill the fields by hand or try again.")
        }))
      );
    }
  });

  // 📋 Review (htmx): blockers, warnings and the preview, without saving.
  web.post("/units/review", upload, async (req, res) => {
    const lang = langOf(req);
    const existing = req.body.version ? await editable(pool, req.session.broker, req.body.code) : null;
    const removeIds = [].concat(req.body.remove_photo || []);
    const current = existing ? (await imagesOf(pool, existing)).filter((i) => !removeIds.includes(i.id)).length : 0;
    const form = Form.unitFromForm(req.body);
    const ev = evaluate({ existing, form, lang, photoCount: current + filesOf(req, "photos").length });
    const duplicate = ev.ok ? await Store.findDuplicate(pool, req.session.broker.agency_id, ev.listing, { excludeId: existing?.id }) : null;
    const catalogue = ev.ok && !duplicate && !existing?.details?.catalogue
      ? await Store.findCatalogueMatch(pool, req.session.broker.agency_id, ev.listing, { excludeId: existing?.id }).catch(() => null)
      : null;
    return res.type("html").send(String(reviewPanel({ ...ev, listing: { ...ev.listing, code: existing?.code || form.code } }, lang, { duplicate, catalogue })));
  });

  // ➡️ Next on a stepped new-unit form: the field rules for the form as it stands, as JSON. Nothing is saved; the page
  // shows the blockers that belong to the step on screen. The duplicate, owner and lead checks stay on the final save.
  web.post("/units/step-check", upload, async (req, res) => {
    const lang = langOf(req);
    const form = Form.unitFromForm(req.body);
    const ev = evaluate({ existing: null, form, lang, photoCount: filesOf(req, "photos").length });
    // A unit that looks like one the agency already has is flagged at the first Next, not only at the final save.
    let duplicate = null;
    try {
      duplicate = ev.listing ? await Store.findDuplicate(pool, req.session.broker.agency_id, ev.listing, {}) : null;
    } catch { /* the final save checks again */ }
    return res.json({ blockers: ev.blockers.map((b) => ({ field: b.field, label: b.label })), duplicate: duplicate || null });
  });

  // ✅ Create: the field table must pass; insert-only (a used code is refused, never overwritten).
  web.post("/units/new", upload, async (req, res) => {
    if (await writesOff(req, res)) return undefined;
    const lang = langOf(req);
    const { broker } = req.session;
    const form = Form.unitFromForm(req.body);
    const files = filesOf(req, "photos").slice(0, MAX_PHOTOS);
    const ev = evaluate({ existing: null, form, lang, photoCount: files.length });
    const again = (status, error, duplicate = null) => {
      traceRefusal(pool, req, { reason: `create_refused_${status}`, listingCode: form.code || null, blockers: ev.blockers.map((b) => b.field) });
      return formPage(req, res, { mode: "new", values: Form.formFromUnit({ ...ev.listing, code: form.code }), review: reviewPanel({ ...ev, listing: { ...ev.listing, code: form.code } }, lang, { duplicate }), error, duplicate }, status);
    };
    if (!ev.ok) return again(422, L10n(lang, "⛔ في بيانات ناقصة. كملها واضغط حفظ.", "⛔ Some required details are missing."));
    const nameError = ownerNameError(ev.listing, req.body, lang);
    if (nameError) return again(422, nameError);
    const compError = await compoundError(pool, ev.listing, req.body, lang);
    if (compError) return again(422, compError);
    const leadError = pinError(req.body, lang) || (await checkOwnerLead(broker, ev.listing, lang));
    if (leadError) return again(422, leadError);
    // P13: a unit that looks like one already listed asks once; "Save anyway" sends force=1.
    if (req.body.force !== "1") {
      const duplicate = await Store.findDuplicate(pool, broker.agency_id, ev.listing);
      if (duplicate) {
        const photosNote = files.length ? L10n(lang, " (اختار الصور تاني قبل الحفظ.)", " (Choose the photos again before saving.)") : "";
        return again(409, L10n(lang, `⚠️ شكلها نفس الوحدة ${duplicate}.${photosNote}`, `⚠️ This looks like ${duplicate}.${photosNote}`), duplicate);
      }
    }

    const photos = await storePhotos(broker, files);
    const client = await pool.connect();
    let result;
    try {
      await client.query("BEGIN");
      result = await Store.createListing(client, broker, { fields: ev.listing, code: form.code, lang });
      if (result.listing) {
        await savePin(client, result.listing, pinFrom(req.body));
        const added = await Store.addPhotos(client, result.listing, photos.urls);
        // The broker ordered the photos by hand: AI ordering is skipped for this unit (saves AI credits).
        if (req.body.photo_manual === "on" && added.length) await Store.reorderPhotos(client, result.listing, added.map((r) => r.id), { force: true });
      }
      await client.query(result.listing ? "COMMIT" : "ROLLBACK");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    if (result.limit) {
      Supabase.deleteStorageFiles(photos.urls).catch(() => {});
      return again(403, Plans.unitLimitText(result.limit, lang));
    }
    if (result.owner_required) {
      Supabase.deleteStorageFiles(photos.urls).catch(() => {});
      return again(400, L10n(lang, "⚠️ لازم تكتب تليفون المالك قبل ما تحفظ الوحدة.", "⚠️ Enter the owner's phone number before saving the unit."));
    }
    if (result.conflict) {
      Supabase.deleteStorageFiles(photos.urls).catch(() => {});
      return again(409, L10n(lang, `⚠️ الكود #${result.code} مستخدم لوحدة أخرى في الشركة. اكتب كود مختلف.`, `⚠️ Code #${result.code} is already used by another unit. Choose another code.`));
    }
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, listing_code: result.listing.code, operation_type: "web_unit_create", metadata: { photos: photos.urls.length, photo_failures: photos.failed } });
    return res.redirect(303, `/app/units/${encodeURIComponent(result.listing.code)}?saved=1`);
  });

  // ✅ Edit: under the (agency, code) advisory lock, with the version the form was opened at.
  web.post("/units/:code/edit", upload, async (req, res, next) => {
    if (await writesOff(req, res)) return undefined;
    const lang = langOf(req);
    const { broker } = req.session;
    const form = Form.unitFromForm(req.body);
    const removeIds = [].concat(req.body.remove_photo || []).filter((id) => /^[0-9a-f-]{36}$/.test(id));
    const files = filesOf(req, "photos");
    const expectedVersion = Number(req.body.version) || -1;
    const photos = await storePhotos(broker, files);

    const out = await Edits.withCodeLock(pool, broker.agency_id, req.params.code, async (client) => {
      const listing = await Store.findByCode(client, broker.agency_id, req.params.code, { forUpdate: true });
      if (!listing) return { rollback: true, missing: true };
      if (!Authz.canEdit(broker, listing)) return { rollback: true, forbidden: true };
      const { rows } = await client.query("SELECT count(*)::int AS n FROM listing_images WHERE listing_id = $1 AND NOT (id = ANY($2::uuid[]))", [listing.id, removeIds]);
      const photoCount = rows[0].n + photos.urls.length;
      const ev = evaluate({ existing: listing, form, lang, photoCount });
      if (!ev.ok) return { rollback: true, listing, ev };
      const nameError = ownerNameError(ev.listing, req.body, lang);
      if (nameError) return { rollback: true, listing, ev, leadError: nameError };
      const compError = ev.listing.compound !== listing.compound ? await compoundError(client, ev.listing, req.body, lang) : null;
      if (compError) return { rollback: true, listing, ev, leadError: compError };
      const leadError = pinError(req.body, lang) || (await checkOwnerLead(broker, ev.listing, lang));
      if (leadError) return { rollback: true, listing, ev, leadError };
      if (photoCount > MAX_PHOTOS) return { rollback: true, listing, ev, tooMany: true };
      const patch = Edits.diffPatch(listing, ev.listing);
      const res2 = await Store.applyListingPatch(client, broker, { listing, patch, expectedVersion });
      if (res2.conflict) return { rollback: true, listing, ev, conflict: true };
      await savePin(client, res2.listing, pinFrom(req.body));
      const removed = await Store.removePhotos(client, listing, removeIds);
      await Store.addPhotos(client, listing, photos.urls);
      // P3: the order the broker dragged the photos into (new photos follow).
      const order = [].concat(req.body.photo_order || []).filter((id) => /^[0-9a-f-]{36}$/.test(id) && !removeIds.includes(id));
      const reordered = (order.length > 1 || req.body.photo_manual === "on") && (await Store.reorderPhotos(client, res2.listing, order, { force: req.body.photo_manual === "on" }));
      return { saved: res2.listing, removed, reordered, columns: Object.keys(patch) };
    });

    if (out.missing || out.forbidden) {
      Supabase.deleteStorageFiles(photos.urls).catch(() => {});
      traceRefusal(pool, req, { reason: out.missing ? "save_unit_not_found" : "save_forbidden", listingCode: req.params.code });
      if (out.missing) return next();
      return res.status(404).type("text/plain").send(L10n(lang, "الوحدة دي مش متاحة لحسابك.", "This unit is not available to your account."));
    }
    if (!out.saved) {
      Supabase.deleteStorageFiles(photos.urls).catch(() => {});
      traceRefusal(pool, req, {
        reason: out.leadError ? "save_owner_or_lead_check" : out.conflict ? "save_version_conflict" : out.tooMany ? "save_too_many_photos" : "save_missing_fields",
        listingCode: out.listing?.code || req.params.code,
        blockers: (out.ev?.blockers || []).map((b) => b.field)
      });
      const error = out.leadError
        ? out.leadError
        : out.conflict
        ? L10n(lang, `⚠️ الوحدة #${out.listing.code} اتعدلت من شخص تاني أثناء التعديل. افتح التعديل من جديد.`, `⚠️ #${out.listing.code} was changed by someone else meanwhile. Open the edit again.`)
        : out.tooMany
        ? L10n(lang, `⚠️ الحد الأقصى ${MAX_PHOTOS} صورة للوحدة.`, `⚠️ At most ${MAX_PHOTOS} photos per unit.`)
        : L10n(lang, "⛔ في بيانات ناقصة. كملها واضغط حفظ.", "⛔ Some required details are missing.");
      return formPage(
        req,
        res,
        {
          mode: "edit",
          code: out.listing.code,
          version: req.body.version,
          values: Form.formFromUnit({ ...out.ev.listing, code: out.listing.code }),
          images: await imagesOf(pool, out.listing),
          review: reviewPanel({ ...out.ev, listing: { ...out.ev.listing, code: out.listing.code } }, lang),
          error
        },
        out.conflict ? 409 : 422
      );
    }
    // Storage files are removed outside the transaction (SEC-04).
    if (out.removed.length) Supabase.deleteStorageFiles(out.removed).catch(() => {});
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, listing_code: out.saved.code, operation_type: "web_unit_edit", metadata: { columns: out.columns, photos_added: photos.urls.length, photos_removed: out.removed.length, photos_reordered: Boolean(out.reordered) } });
    return res.redirect(303, `/app/units/${encodeURIComponent(out.saved.code)}?saved=1`);
  });
}

module.exports = { register, storePhotos };
