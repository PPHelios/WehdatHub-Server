// lib/drafts.js — Distributed Draft State Machine, Ingress Staging & Atomic Commits
"use strict";

const L = require("./listing");
const Supabase = require("./supabase");
const Store = require("./listingStore");
const Links = require("./links");
const Rules = require("../domain/fieldRules");
const Describe = require("../domain/describe");
const Phone = require("../domain/phone");
const { parseOwnerLine } = require("../domain/ownerLine");
const Places = require("../domain/places");
const PlaceNames = require("./placeNames");
const { t } = require("./copy");
const AiBlock = require("./aiBlock");
const { isAgencyOwner } = require("./authz");
const Vis = require("../lib/visibility");

const MAX_IMAGES = 15;
const DRAFT_TTL_MS = 15 * 60 * 1000; // 15-minute sliding TTL

/**
 * Retrieves the broker's current active draft from PostgreSQL broker_sessions.
 * Complies strictly with SCHEMA_REFERENCE.sql (table: broker_sessions).
 */
async function getDraft(pool, brokerId, sessionType = "draft") {
  if (!pool || !brokerId) return null;

  const res = await pool.query(
    `SELECT session_data, expires_at
     FROM broker_sessions
     WHERE broker_id = $1::uuid AND session_type = $2::text`,
    [brokerId, sessionType]
  );

  const session = res.rows[0];
  if (!session) return null;

  // Lazy TTL Eviction: automatically purge sessions older than 15 minutes
  if (new Date(session.expires_at) <= new Date()) {
    await clearDraft(pool, brokerId, sessionType);
    return null;
  }

  return session.session_data;
}

/**
 * Creates or resets an active session in broker_sessions atomically.
 */
async function createDraft(
  pool,
  brokerId,
  agencyId,
  brokerPhoneNormalized = "",
  sessionType = "draft"
) {
  if (!pool || !brokerId) return null;

  const initialData = {
    broker_id: brokerId,
    agency_id: agencyId,
    broker_phone: brokerPhoneNormalized,
    media_items: [],
    voice_buffers: [],
    text_notes: [],
    custom_code: null,
    staged_review: null,
    created_at: Date.now()
  };

  await pool.query(
    `INSERT INTO broker_sessions (broker_id, session_type, session_data, expires_at)
     VALUES ($1::uuid, $2::text, $3::jsonb, NOW() + INTERVAL '15 minutes')
     ON CONFLICT (broker_id, session_type) DO UPDATE SET
       session_data = EXCLUDED.session_data,
       expires_at = NOW() + INTERVAL '15 minutes'`,
    [brokerId, sessionType, JSON.stringify(initialData)]
  );

  return initialData;
}

/**
 * Permanently removes a draft session from broker_sessions.
 */
async function clearDraft(pool, brokerId, sessionType = "draft") {
  if (!pool || !brokerId) return;
  await pool.query(
    `DELETE FROM broker_sessions
     WHERE broker_id = $1::uuid AND session_type = $2::text`,
    [brokerId, sessionType]
  );
}

/**
 * Appends a written specification note atomically using SQL JSONB operators.
 */
async function appendText(pool, brokerId, text, sessionType = "draft") {
  const clean = String(text || "").trim();
  if (!pool || !brokerId || !clean) return null;

  const res = await pool.query(
    `INSERT INTO broker_sessions (broker_id, session_type, session_data, expires_at)
     VALUES ($1::uuid, $2::text, jsonb_build_object('broker_id', $1::text, 'text_notes', jsonb_build_array($3::text), 'media_items', '[]'::jsonb, 'voice_buffers', '[]'::jsonb, 'created_at', extract(epoch from now()) * 1000), NOW() + INTERVAL '15 minutes')
     ON CONFLICT (broker_id, session_type) DO UPDATE SET
       session_data = jsonb_set(
         broker_sessions.session_data - 'staged_review',
         '{text_notes}',
         COALESCE(broker_sessions.session_data->'text_notes', '[]'::jsonb) || jsonb_build_array($3::text),
         true
       ),
       expires_at = NOW() + INTERVAL '15 minutes'
     RETURNING session_data`,
    [brokerId, sessionType, clean]
  );

  return res.rows[0]?.session_data || null;
}

/**
 * Appends a voice note buffer atomically using SQL JSONB operators.
 */
async function appendVoice(
  pool,
  brokerId,
  { buffer, mimeType = "audio/ogg" },
  sessionType = "draft"
) {
  if (!pool || !brokerId || !buffer) return null;

  const voiceObj = {
    mimeType,
    base64: buffer.toString("base64")
  };

  const res = await pool.query(
    `INSERT INTO broker_sessions (broker_id, session_type, session_data, expires_at)
     VALUES ($1::uuid, $2::text, jsonb_build_object('broker_id', $1::text, 'voice_buffers', jsonb_build_array($3::jsonb), 'media_items', '[]'::jsonb, 'text_notes', '[]'::jsonb, 'created_at', extract(epoch from now()) * 1000), NOW() + INTERVAL '15 minutes')
     ON CONFLICT (broker_id, session_type) DO UPDATE SET
       session_data = jsonb_set(
         broker_sessions.session_data - 'staged_review',
         '{voice_buffers}',
         COALESCE(broker_sessions.session_data->'voice_buffers', '[]'::jsonb) || jsonb_build_array($3::jsonb),
         true
       ),
       expires_at = NOW() + INTERVAL '15 minutes'
     RETURNING session_data`,
    [brokerId, sessionType, JSON.stringify(voiceObj)]
  );

  return res.rows[0]?.session_data || null;
}

/**
 * The line a broker's next reply in a draft starts with, for photos no reply has mentioned yet (P11:
 * no message per photo). Returns { text, onDelivered } or null; onDelivered marks them mentioned.
 */
async function photoNote(pool, broker, lang = "ar") {
  const draft = await getDraft(pool, broker.id, "draft");
  if (!draft) return null;
  const total = (draft.media_items || []).length;
  const fresh = total - Number(draft.photos_acked || 0);
  if (fresh <= 0) return null;
  return {
    text: t(fresh === 1 ? "photo_received" : "photos_received", lang, { n: fresh }),
    onDelivered: () =>
      pool.query(
        `UPDATE broker_sessions SET session_data = jsonb_set(session_data, '{photos_acked}', to_jsonb($2::int), true)
          WHERE broker_id = $1 AND session_type = 'draft'`,
        [broker.id, total]
      )
  };
}

/**
 * True for the first caller only once a draft is at the photo ceiling, so a burst of extra photos
 * gets one limit warning instead of one per dropped photo.
 */
async function claimLimitWarning(pool, brokerId, sessionType = "draft") {
  if (!pool || !brokerId) return false;
  const res = await pool.query(
    `UPDATE broker_sessions SET session_data = jsonb_set(session_data, '{limit_warned}', 'true'::jsonb, true)
      WHERE broker_id = $1::uuid AND session_type = $2::text
        AND COALESCE((session_data->>'limit_warned')::boolean, false) = false
      RETURNING broker_id`,
    [brokerId, sessionType]
  );
  return res.rows.length > 0;
}

/**
 * Appends an image atomically, enforcing the 15-photo ceiling (ING-01) with deduplication check.
 */
async function appendMedia(
  pool,
  brokerId,
  { mediaId, buffer, url = null, mimeType = "image/jpeg" },
  sessionType = "draft"
) {
  if (!pool || !brokerId || (!buffer && !url)) {
    return { ok: false, limitReached: false, count: 0 };
  }

  const currentDraft = await getDraft(pool, brokerId, sessionType);
  const mediaItems = currentDraft?.media_items || [];

  if (mediaItems.length >= MAX_IMAGES) {
    return { ok: false, limitReached: true, count: mediaItems.length };
  }

  const exists = mediaItems.some((item) => item.mediaId === mediaId);
  if (exists) {
    return {
      ok: true,
      limitReached: mediaItems.length >= MAX_IMAGES,
      count: mediaItems.length,
      draft: currentDraft
    };
  }

  // Photos are uploaded to storage at ingest; base64 is kept only when that upload failed.
  const mediaObj = url
    ? { mediaId, mimeType, url }
    : { mediaId, mimeType, base64: buffer.toString("base64") };

  const res = await pool.query(
    `INSERT INTO broker_sessions (broker_id, session_type, session_data, expires_at)
     VALUES ($1::uuid, $2::text, jsonb_build_object('broker_id', $1::text, 'media_items', jsonb_build_array($3::jsonb), 'voice_buffers', '[]'::jsonb, 'text_notes', '[]'::jsonb, 'created_at', extract(epoch from now()) * 1000), NOW() + INTERVAL '15 minutes')
     ON CONFLICT (broker_id, session_type) DO UPDATE SET
       session_data = CASE
         WHEN jsonb_array_length(COALESCE(broker_sessions.session_data->'media_items', '[]'::jsonb)) >= 15
         THEN broker_sessions.session_data
         ELSE jsonb_set(
           broker_sessions.session_data,
           '{media_items}',
           COALESCE(broker_sessions.session_data->'media_items', '[]'::jsonb) || jsonb_build_array($3::jsonb),
           true
         )
       END,
       expires_at = NOW() + INTERVAL '15 minutes'
     RETURNING session_data`,
    [brokerId, sessionType, JSON.stringify(mediaObj)]
  );

  const updatedDraft = res.rows[0]?.session_data || currentDraft;
  const updatedCount = (updatedDraft.media_items || []).length;

  return {
    ok: true,
    limitReached: updatedCount >= MAX_IMAGES,
    count: updatedCount,
    draft: updatedDraft
  };
}

/**
 * Persists an AI-extracted review draft into staged_review in broker_sessions atomically.
 */
async function stageDraftReview(pool, brokerId, reviewPayload) {
  const res = await pool.query(
    `UPDATE broker_sessions
     SET session_data = jsonb_set(session_data, '{staged_review}', $1::jsonb, true),
         expires_at = NOW() + INTERVAL '15 minutes'
     WHERE broker_id = $2::uuid AND session_type = 'draft'
     RETURNING session_data`,
    [JSON.stringify(reviewPayload), brokerId]
  );

  return res.rows[0]?.session_data || null;
}

/**
 * Retrieves staged review object, verifying sliding TTL.
 */
async function getStagedReview(pool, brokerId) {
  const draft = await getDraft(pool, brokerId, "draft");
  return draft?.staged_review || null;
}

/** Clears a staged review after new input, so only a review of the current inputs can be committed. */
async function invalidateStagedReview(pool, brokerId) {
  await pool.query(
    `UPDATE broker_sessions SET session_data = session_data - 'staged_review' - 'owner_decision' - 'compound_decision'
     WHERE broker_id = $1::uuid AND session_type = 'draft' AND (session_data ? 'staged_review' OR session_data ? 'owner_decision' OR session_data ? 'compound_decision')`,
    [brokerId]
  );
}

/** The owner line on the review card: who the phone belongs to, and what the broker chose. */
function ownerLine({ ownerPhone, ownerDecision, existingOwner, name, lang }) {
  if (!ownerPhone) return "";
  const en = lang === "en";
  const who = name || existingOwner?.name || ownerPhone;
  if (ownerDecision === "drop") return `\n\n👤 ${en ? "Owner not saved (discarded)" : "المالك مش هيتسجل (اتشال)"}`;
  if (!ownerDecision) {
    if (ownerNameDiffers(existingOwner, name)) {
      return `\n\n👤 ${en
        ? `Saved owner: ${existingOwner.name} (${ownerPhone}). You typed: ${name}. Which name should the owner keep?`
        : `المالك المحفوظ: ${existingOwner.name} (${ownerPhone}). إنت كاتب: ${name}. تحب الاسم اللي يتحفظ يبقى إيه؟`}`;
    }
    return existingOwner
      ? `\n\n👤 ${en ? `Existing owner: ${existingOwner.name || ownerPhone} (${ownerPhone}). Link this unit to them?` : `مالك موجود: ${existingOwner.name || ownerPhone} (${ownerPhone}). تربط الوحدة بيه؟`}`
      : `\n\n👤 ${en ? `New owner: ${who} (${ownerPhone}). Create and link?` : `مالك جديد: ${who} (${ownerPhone}). تضيفه وتربط الوحدة بيه؟`}`;
  }
  return `\n\n👤 ${en ? `Owner: ${who}` : `المالك: ${who}`}`;
}

/** A saved owner with a name that differs from the one typed on the draft (a saved blank name is simply filled). */
function ownerNameDiffers(existingOwner, typed) {
  const norm = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
  return Boolean(existingOwner?.name && typed && norm(existingOwner.name) !== norm(typed));
}

/** The owner choice while the card waits for one: keep (link or create). A unit always has an owner, so there is no discard. */
function ownerButtons(lang, { existing = false, differs = false } = {}) {
  const en = lang === "en";
  if (differs) {
    return [
      { id: "draft_owner_keep", title: en ? "Keep saved name ✅" : "احفظ الاسم المحفوظ ✅" },
      { id: "draft_owner_keep_typed", title: en ? "Use typed name ✅" : "احفظ الاسم اللي كتبته ✅" },
      { id: "draft_cancel", title: en ? "Cancel ❌" : "إلغاء ❌" }
    ];
  }
  return [
    { id: "draft_owner_keep", title: existing ? (en ? "Link to them ✅" : "اربطها بيه ✅") : en ? "Create & link ✅" : "أضيفه واربطه ✅" },
    { id: "draft_cancel", title: en ? "Cancel ❌" : "إلغاء ❌" }
  ];
}

// F2: a card with something missing gets Review (send the missing detail, then tap) next to Cancel.
const draftButtons = (lang, { confirm = true, anyway = false } = {}) =>
  [
    !confirm && { id: "DRAFT_SAVE", title: lang === "en" ? "Review 🔄" : "مراجعة 🔄" },
    confirm && { id: "draft_confirm", title: anyway ? (lang === "en" ? "Save anyway ✅" : "احفظ برضه ✅") : lang === "en" ? "Confirm & Save ✅" : "تأكيد وحفظ ✅" },
    confirm && { id: "draft_edit", title: lang === "en" ? "Edit ✏️" : "تعديل ✏️" },
    { id: "draft_cancel", title: lang === "en" ? "Cancel ❌" : "إلغاء ❌" }
  ].filter(Boolean);

/**
 * DRF-02: runs AI extraction over every input in the draft, applies the field table and stages
 * the result. Replies with the review card (warnings shown only here) or with what is still missing.
 */
async function reviewDraft(broker, ctx) {
  require("./dispatcher").setTurnAction("add_unit");
  const { pool, lang } = ctx;
  const { reply, replyButtons } = require("./dispatcher");
  const draft = await getDraft(pool, broker.id, "draft");
  if (!draft) {
    await reply(
      broker,
      lang === "en"
        ? "⏳ Draft session expired. Send photos or details to start a new listing."
        : "⏳ انتهت صلاحية المسودة. أرسل الصور أو المواصفات لبدء وحدة جديدة."
    );
    return "done";
  }
  // The AI read can take ~20 s (model fallbacks): a "working on it" line first, so the broker doesn't re-tap.
  return require("./dispatcher").withProgress(broker, t("review_working", lang), () => extractAndReview(broker, ctx, draft));
}

/** The AI read of a draft's inputs, then the review card (or the retry message when the AI fails). */
async function extractAndReview(broker, ctx, draft) {
  const { lang } = ctx;
  const { replyButtons } = require("./dispatcher");
  const texts = draft.text_notes || [];
  const voice = draft.voice_buffers || [];
  const t0 = Date.now();
  let extracted;
  try {
    extracted = await L.extractPropertyDetails(ctx.AI, { texts, voice, lang, ctx: { ...ctx, broker } });
  } catch (err) {
    console.error("Draft extraction failed:", err.message);
    await replyButtons(
      broker,
      AiBlock.kindOf(err) !== "ai"
        ? `${AiBlock.text(AiBlock.kindOf(err), lang, { owner: isAgencyOwner(broker) })}\n${lang === "en" ? "You can add the unit with the form on the website, it needs no credits." : "تقدر تضيف الوحدة من الفورم في الموقع، من غير رصيد."}`
        : lang === "en"
        ? "❌ Could not read the unit details right now. Your draft is kept; tap Review again in a moment."
        : "❌ تعذر قراءة مواصفات الوحدة حالياً. المسودة محفوظة؛ اضغط مراجعة مرة أخرى بعد قليل.",
      [
        { id: "DRAFT_SAVE", title: lang === "en" ? "Review again 🔄" : "مراجعة تاني 🔄" },
        { id: "draft_cancel", title: lang === "en" ? "Cancel ❌" : "إلغاء ❌" }
      ]
    );
    return "done";
  }

  const composed = L.composeFields({ draft: extracted.fields, lang });
  // A seller lead's "➕ Add their unit": the owner's name and phone are internal details, unless the broker said otherwise.
  for (const [k, v] of Object.entries(draft.prefill?.details || {})) {
    if (v && !composed.details?.[k]) composed.details = { ...(composed.details || {}), [k]: v };
  }
  // An owner written on its own line ("Owner: Name 01…" or "المالك Name 01…") is read exactly, not by the AI.
  const ownerTyped = parseOwnerLine(texts);
  if (ownerTyped) {
    composed.details = { ...(composed.details || {}), owner_name: ownerTyped.name, owner_phone: Phone.displayPhone(ownerTyped.phone) };
  }
  // F6: a compound the AI wrote as it heard it snaps to a known name (the agency's own first); the card says so.
  let snapNote = "";
  if (composed.compound) {
    const snap = Places.snapCompound(composed.compound, await agencyPlaceNames(ctx.pool, broker.agency_id));
    if (snap.changed) {
      snapNote = lang === "en" ? `\n\n✏️ Compound name corrected: ${composed.compound} → ${snap.name}` : `\n\n✏️ اسم الكمبوند اتصحح: ${composed.compound} ← ${snap.name}`;
      composed.compound = snap.name;
    }
    // A compound the app has never seen waits for the CRM owner's Arabic name (lib/placeNames.js); never blocks the unit.
    await PlaceNames.noteUnknown(ctx.pool, composed.compound, { example: "unit", brokerId: broker.id }).catch(() => {});
    // The approved list decides: a match writes the list's names and moves the details to the notes; no match is said on the card.
    const norm = await require("../services/compoundResolve").normalize(ctx.pool, composed).catch(() => null);
    if (norm?.compound_state === "needs_fix") {
      // Not on the list: the review card asks which one it is (see presentReview).
    } else if (norm?.place_id) {
      composed.compound = norm.compound;
      composed.compound_en = norm.compound_en;
      composed.details = norm.details;
    }
  }
  return await presentReview(broker, ctx, draft, {
    snapNote,
    source: composed,
    code: extracted.fields.code || draft.custom_code || null,
    model: extracted.modelUsed,
    t0
  });
}

/**
 * Applies the field table to the composed fields, stages the result and sends the review card.
 * `source` (the composed fields before the rules) is staged too, so answering the installments
 * question re-evaluates without another AI call.
 */
async function presentReview(broker, ctx, draft, { source, code, model, t0 = Date.now(), snapNote = "" }) {
  const { pool, lang } = ctx;
  const { replyButtons } = require("./dispatcher");
  const texts = draft.text_notes || [];
  const voice = draft.voice_buffers || [];
  const photoCount = (draft.media_items || []).length;
  const answer = draft.installments_answer;
  const input = typeof answer === "boolean" ? { ...source, installments_confirmed: answer } : source;
  const evaluation = Rules.evaluate(input, { lang, photoCount, askInstallments: true });
  delete evaluation.listing.installments_confirmed;
  // The owner (matched by phone) is confirmed on the card: keep it (link to the existing owner, or create one) or discard it.
  const ownerPhone = evaluation.listing.details?.owner_phone || null;
  const existingOwner = ownerPhone ? await require("../services/unitOwners").findByPhone(pool, broker.agency_id, ownerPhone).catch(() => null) : null;
  // A new or matching owner is created or linked when the unit is saved, with no question. Only a saved owner under
  // another name still asks which name to keep.
  const nameClash = Boolean(ownerPhone) && ownerNameDiffers(existingOwner, evaluation.listing.details?.owner_name);
  const ownerDecision = draft.owner_decision || (ownerPhone && !nameClash ? "keep" : null);
  const ownerPending = Boolean(ownerPhone) && !ownerDecision;
  // The broker kept the saved name: the unit shows and stores that name (a typed name is only saved on "Use typed name").
  if (ownerPhone && ownerDecision === "keep" && ownerNameDiffers(existingOwner, evaluation.listing.details?.owner_name)) {
    evaluation.listing.details.owner_name = existingOwner.name;
  }
  if (ownerPhone && ownerDecision === "drop") {
    for (const k of ["owner_name", "owner_phone", "owner_lead"]) delete evaluation.listing.details[k];
  }
  // P13: a unit that looks like one already listed is flagged on this card (no extra message); Confirm saves anyway.
  const duplicate = evaluation.ok ? await Store.findDuplicate(pool, broker.agency_id, evaluation.listing).catch(() => null) : null;
  // C3: a soft note when it looks like a unit or model of the agency's catalogue (never blocks).
  const catalogue = evaluation.ok && !duplicate ? await Store.findCatalogueMatch(pool, broker.agency_id, evaluation.listing).catch(() => null) : null;

  await stageDraftReview(pool, broker.id, {
    ok: evaluation.ok && !ownerPending,
    duplicate,
    fields: evaluation.listing,
    source,
    code,
    warnings: evaluation.warnings,
    blockers: evaluation.blockers,
    inputs: { texts: texts.length, voice: voice.length, photos: photoCount },
    model,
    staged_at: Date.now()
  });

  logDraftOp(pool, broker, {
    operation_type: "draft_review",
    status: evaluation.ok ? "success" : "incomplete",
    total_duration_ms: Date.now() - t0,
    metadata: { blockers: evaluation.blockers.map((b) => b.field), warnings: evaluation.warnings.map((w) => w.field) }
  });

  const card = Describe.reviewCard(
    { ...evaluation.listing, code: code || (lang === "en" ? "(auto)" : "(تلقائي)") },
    { warnings: evaluation.warnings, blockers: evaluation.blockers, photoCount, lang }
  ) + ownerLine({ ownerPhone, ownerDecision, existingOwner, name: evaluation.listing.details?.owner_name, lang });
  const dupLine = duplicate
    ? `\n\n${t("draft_duplicate", lang, { code: duplicate, url: Links.unitAppUrl(duplicate) })}`
    : catalogue ? `\n\n${t("draft_catalogue", lang, catalogueVars(catalogue, lang))}` : "";
  const question = evaluation.blockers.find((b) => b.field === "installments_question");
  // A compound that is not on the approved list: pick a close one, or add it as new (kept until the owner checks it).
  const typedCompound = evaluation.listing.compound;
  const compoundSuggestions = typedCompound && draft.compound_decision !== "new" && !ownerPending
    ? (await require("../services/compoundResolve").resolve(pool, { compound: typedCompound, compound_en: evaluation.listing.compound_en })).compound_state === "needs_fix"
      ? await require("../services/compoundResolve").suggest(pool, typedCompound, 2)
      : null
    : null;
  const compoundPending = Array.isArray(compoundSuggestions);
  const buttons = compoundPending
    ? compoundButtons(lang, compoundSuggestions)
    : ownerPending
    ? ownerButtons(lang, { existing: Boolean(existingOwner), differs: ownerNameDiffers(existingOwner, evaluation.listing.details?.owner_name) })
    : question
    ? [
        { id: "draft_inst_yes", title: lang === "en" ? "Yes, installments" : "أيوه، أقساط" },
        { id: "draft_inst_no", title: lang === "en" ? `No, ${Rules.money(question.question.paid, lang)} cash` : `لا، ${Rules.money(question.question.paid, lang)} كاش` },
        { id: "draft_cancel", title: lang === "en" ? "Cancel ❌" : "إلغاء ❌" }
      ]
    : draftButtons(lang, { confirm: evaluation.ok, anyway: Boolean(duplicate) });
  const compoundLine = compoundPending
    ? `\n\n⚠️ ${lang === "en" ? `"${typedCompound}" is not on the approved compound list. Pick the right one, or add it as new.` : `"${typedCompound}" مش في قائمة الكمبوندات المعتمدة. اختار الصح أو ضيفه كجديد.`}`
    : "";
  await replyButtons(broker, card + snapNote.replace(/\n\n⚠️ (Compound|الكمبوند)[^\n]*/, "") + compoundLine + dupLine, buttons);
  return "done";
}

function compoundButtons(lang, suggestions) {
  const en = lang === "en";
  return [
    ...suggestions.map((s) => ({ id: `draft_comp:${s.id}`, title: String(en ? s.name : s.name_ar || s.name).slice(0, 24) })),
    { id: "draft_comp_new", title: en ? "Add as new ➕" : "ضيفه كجديد ➕" }
  ];
}

/** The broker's answer on the compound card: a listed place (its id) or "new". The review is shown again with it. */
async function answerCompound(broker, ctx, choice) {
  require("./dispatcher").setTurnAction("add_unit");
  const { pool } = ctx;
  const { rows } = await pool.query(
    `UPDATE broker_sessions SET session_data = jsonb_set(session_data, '{compound_decision}', to_jsonb($2::text), true)
      WHERE broker_id = $1::uuid AND session_type = 'draft' AND expires_at > NOW()
      RETURNING session_data`,
    [broker.id, choice === "new" ? "new" : "pick"]
  );
  const draft = rows[0]?.session_data;
  const staged = draft?.staged_review;
  if (!staged?.source) return reviewDraft(broker, ctx);
  let source = staged.source;
  if (choice !== "new") {
    const { rows: pl } = await pool.query("SELECT name_en, name_ar FROM map_places WHERE id = $1 AND approved", [choice]);
    if (pl[0]) source = { ...source, compound: pl[0].name_ar || pl[0].name_en, compound_en: pl[0].name_en };
  }
  return presentReview(broker, ctx, { ...draft, compound_decision: choice === "new" ? "new" : "pick" }, { source, code: staged.code, model: staged.model });
}

/** The compound and project names the agency already uses (for F6 snapping). */
async function agencyPlaceNames(pool, agencyId) {
  const { rows } = await pool
    .query(
      `SELECT DISTINCT n FROM (SELECT compound AS n FROM listings WHERE ${Vis.units("listings")} AND agency_id = $1 AND compound IS NOT NULL
         UNION SELECT name FROM projects WHERE agency_id = $1) x WHERE length(n) BETWEEN 3 AND 80 LIMIT 500`,
      [agencyId]
    )
    .catch(() => ({ rows: [] }));
  return rows.map((r) => r.n);
}

/**
 * The broker's answer to "is the rest paid in installments?" (draft_inst_yes / draft_inst_no): kept on the
 * draft (a later review keeps it) and applied to the staged fields without another AI call.
 */
async function answerInstallments(broker, ctx, yes) {
  require("./dispatcher").setTurnAction("add_unit");
  const { pool } = ctx;
  const { rows } = await pool.query(
    `UPDATE broker_sessions SET session_data = jsonb_set(session_data, '{installments_answer}', to_jsonb($2::boolean), true)
      WHERE broker_id = $1::uuid AND session_type = 'draft' AND expires_at > NOW()
      RETURNING session_data`,
    [broker.id, yes]
  );
  const draft = rows[0]?.session_data;
  const staged = draft?.staged_review;
  if (!staged?.source) return reviewDraft(broker, ctx);
  return presentReview(broker, ctx, draft, { source: staged.source, code: staged.code, model: staged.model });
}

/**
 * The broker's answer to the owner card (draft_owner_keep / draft_owner_drop). Kept on the draft until new input,
 * then the review is shown again with the owner as chosen.
 */
async function answerOwner(broker, ctx, choice) {
  require("./dispatcher").setTurnAction("add_unit");
  const { pool } = ctx;
  const decision = choice === "keep_typed" || choice === "drop" ? choice : "keep";
  const { rows } = await pool.query(
    `UPDATE broker_sessions SET session_data = jsonb_set(session_data, '{owner_decision}', to_jsonb($2::text), true)
      WHERE broker_id = $1::uuid AND session_type = 'draft' AND expires_at > NOW()
      RETURNING session_data`,
    [broker.id, decision]
  );
  const draft = rows[0]?.session_data;
  const staged = draft?.staged_review;
  if (!staged?.source) return reviewDraft(broker, ctx);
  return presentReview(broker, ctx, draft, { source: staged.source, code: staged.code, model: staged.model });
}

/**
 * DRF-03: commits ONLY the staged review. Insert-only: an existing code is never overwritten
 * (23505 → "الكود مستخدم", draft kept). The draft is consumed in the same transaction.
 */
async function commitStagedReview(broker, ctx) {
  require("./dispatcher").setTurnAction("add_unit");
  const { pool, lang } = ctx;
  const { reply, replyButtons } = require("./dispatcher");
  const client = await pool.connect();
  let committed = null;
  let outcome = null;
  try {
    await client.query("BEGIN");
    // Atomic consumption: a double tap finds nothing on the second run.
    const { rows } = await client.query(
      `DELETE FROM broker_sessions WHERE broker_id = $1::uuid AND session_type = 'draft' AND expires_at > NOW()
       RETURNING session_data`,
      [broker.id]
    );
    const draft = rows[0]?.session_data;
    const staged = draft?.staged_review;
    if (!draft) outcome = "expired";
    else if (!staged || !staged.ok) outcome = "needs_review";
    else if (!(await require("../services/unitRights").mayWrite(client, broker))) outcome = "writes_off";
    if (outcome) {
      await client.query("ROLLBACK");
    } else {
      const res = await insertListing(client, broker, staged, draft, lang);
      if (res.owner_required || res.owner_name_required) {
        await client.query("ROLLBACK"); // draft restored: the broker sends the owner's number (and name)
        outcome = res.owner_name_required ? "owner_name_required" : "owner_required";
      } else if (res.limit) {
        await client.query("ROLLBACK"); // draft restored
        outcome = "unit_limit";
        committed = res.limit;
      } else if (res.conflict) {
        await client.query("ROLLBACK"); // draft restored
        outcome = "code_taken";
        committed = { code: res.code };
      } else {
        await client.query("COMMIT");
        committed = res.listing;
        // The broker chose the typed name for the saved owner: rename it (history kept), after the unit is saved.
        if (draft.owner_decision === "keep_typed") {
          const d = res.listing?.details || {};
          await require("../services/unitOwners").renameFromDraft(pool, broker, d.owner_phone, d.owner_name, { listing: res.listing }).catch(() => {});
        }
      }
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (outcome === "expired") {
    await reply(
      broker,
      lang === "en"
        ? "⚠️ This draft was already saved or has expired. Send new details to add a unit."
        : "⚠️ تم حفظ هذه المسودة مسبقاً أو انتهت صلاحيتها. أرسل تفاصيل جديدة لإضافة وحدة."
    );
    return "done";
  }
  if (outcome === "needs_review") return reviewDraft(broker, ctx);
  if (outcome === "owner_required") {
    await reply(broker, lang === "en"
      ? "⚠️ A unit needs its owner's phone number before it is saved. Send the number (you can send the owner's contact) and tap Review."
      : "⚠️ لازم رقم تليفون المالك قبل ما الوحدة تتحفظ. ابعت الرقم (أو جهة اتصال المالك) واضغط مراجعة.");
    return "done";
  }
  if (outcome === "owner_name_required") {
    await reply(broker, lang === "en"
      ? "⚠️ A unit needs its owner's name as well as the phone number. Send the owner's name, then tap Review."
      : "⚠️ لازم اسم المالك مع رقم تليفونه قبل ما الوحدة تتحفظ. ابعت الاسم واضغط مراجعة.");
    return "done";
  }
  if (outcome === "writes_off") {
    await reply(broker, lang === "en"
      ? "⚠️ The agency owner has switched off adding units for brokers. Ask your manager."
      : "⚠️ مالك الشركة قفل إضافة الوحدات للسماسرة. كلّم المدير.");
    return "done";
  }
  if (outcome === "unit_limit") {
    await reply(broker, require("../domain/plans").unitLimitText(committed, lang));
    return "done";
  }
  if (outcome === "code_taken") {
    await replyButtons(
      broker,
      lang === "en"
        ? `⚠️ Code #${committed.code} is already used by another unit in your agency. Send a different code (e.g. "code ${committed.code}-2") and tap Review.`
        : `⚠️ الكود #${committed.code} مستخدم لوحدة أخرى في الشركة. أرسل كود مختلف (مثال: «كود ${committed.code}-2») ثم اضغط مراجعة.`,
      [
        { id: "DRAFT_SAVE", title: lang === "en" ? "Review 🔄" : "مراجعة 🔄" },
        { id: "draft_cancel", title: lang === "en" ? "Cancel ❌" : "إلغاء ❌" }
      ]
    );
    return "done";
  }

  logDraftOp(pool, broker, { operation_type: "draft_commit", listing_code: committed.code });
  // Wow 1: clients whose requests this unit fits, in the same reply (no extra message). Their button takes Edit's
  // place (Edit stays one message away: «تعديل CODE»).
  const wants = await require("../services/leadRequests").whoWants(pool, broker, committed).catch(() => ({ total: 0 }));
  const wanted = wants.total ? `\n\n${t("unit_wanted", lang, { n: wants.total })}` : "";
  // P1: the price per m² against similar units in the same compound (finishing, rent extras).
  const Insights = require("../services/priceInsights");
  const market = Insights.noteLine(await Insights.forUnit(pool, committed).catch(() => null), committed, lang);
  const hint = await require("../services/onboarding").firstHint(pool, broker, "unit").catch(() => null);
  // The flyer costs credits only when it will order the photos with AI (first flyer, or after new photos).
  const listingId = committed.id || (await pool.query("SELECT id FROM listings WHERE " + Vis.units("listings") + " AND agency_id = $1 AND code = $2", [broker.agency_id, committed.code]).then((r) => r.rows[0]?.id).catch(() => null));
  const flyerCredits = listingId && (await require("./vision").needsCuration(pool, listingId).catch(() => false)) ? await require("../services/credits").creditsFor(pool, "flyer").catch(() => 0) : 0;
  const costTag = flyerCredits ? ` (${flyerCredits})` : "";
  await replyButtons(broker, Describe.savedCard(committed, { lang }) + (market ? `\n\n${market}` : "") + wanted + (hint ? `\n\n${hint}` : ""), [
    { id: `client:${committed.code}`, title: lang === "en" ? "Client Copy 📱" : "نص العميل 📱" },
    { id: `flyer:en:dark:${committed.code}`, title: (lang === "en" ? "Flyer 📄" : "الكتالوج 📄") + costTag },
    wants.total
      ? { id: `ld:wants:${committed.code}`, title: lang === "en" ? `🔥 ${wants.total} clients` : `🔥 ${wants.total} عملاء` }
      : { id: `edit:${committed.code}`, title: lang === "en" ? "Edit ✏️" : "تعديل ✏️" }
  ]);
  return "done";
}

/**
 * Inserts the staged listing (lib/listingStore.js createListing: insert-only) and its photos.
 * A stated code that exists returns { conflict }; a generated code that collides is regenerated.
 */
async function insertListing(client, broker, staged, draft, lang) {
  const res = await Store.createListing(client, broker, { fields: staged.fields, code: staged.code || null, lang });
  if (res.listing) await attachDraftPhotos(client, broker, res.listing, draft.media_items || []);
  return res;
}

/** Links photos (uploaded to storage at ingest) to the new listing, in arrival order. */
async function attachDraftPhotos(client, broker, listing, mediaItems) {
  for (let i = 0; i < mediaItems.length; i++) {
    const item = mediaItems[i];
    let url = item.url || null;
    if (!url && item.base64) {
      // Fallback for photos whose upload failed at ingest.
      url = await Supabase.uploadListingImage(
        broker.agency_id,
        `listings/${broker.agency_id}/${listing.id}/${Date.now()}_${i}.jpg`,
        Buffer.from(item.base64, "base64")
      );
    }
    if (url) {
      await client.query(
        `INSERT INTO listing_images (listing_id, agency_id, position, url, role)
         VALUES ($1::uuid, $2::uuid, $3::integer, $4::text, NULL)`,
        [listing.id, broker.agency_id, i, url]
      );
    }
  }
}

function logDraftOp(pool, broker, row) {
  pool
    .query(
      `INSERT INTO operation_logs (agency_id, broker_id, listing_code, operation_type, status, total_duration_ms, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())`,
      [
        broker.agency_id,
        broker.id,
        row.listing_code || null,
        row.operation_type,
        row.status || "success",
        Math.round(row.total_duration_ms || 0),
        JSON.stringify(row.metadata || {})
      ]
    )
    .catch((e) => console.warn("Draft telemetry log warning:", e.message));
}

/**
 * Legacy Adapter preserving backward compatibility with tests and older controllers.
 */
async function appendToDraft(pool, broker, { mediaId, buffer, text } = {}) {
  const phone = broker.phone_normalized || broker.phone_number;
  let draft = await getDraft(pool, broker.id, "draft");
  if (!draft) {
    draft = await createDraft(
      pool,
      broker.id,
      broker.agency_id,
      phone,
      "draft"
    );
  }

  if (text) await appendText(pool, broker.id, text, "draft");
  if (buffer) {
    await appendMedia(
      pool,
      broker.id,
      {
        mediaId: mediaId || `img_${Date.now()}`,
        buffer,
        mimeType: "image/jpeg"
      },
      "draft"
    );
  }

  const refreshed = await getDraft(pool, broker.id, "draft");
  return {
    draft: refreshed,
    isNew: false,
    mediaLimitReached: (refreshed?.media_items || []).length >= MAX_IMAGES
  };
}

/** Words for the catalogue soft note: "a model" or "unit <dev code>", the project, the agency code. */
function catalogueVars(c, lang) {
  const what = c.model ? (lang === "en" ? "a model" : "نموذج") : c.dev_code ? (lang === "en" ? `unit ${c.dev_code}` : `الوحدة ${c.dev_code}`) : lang === "en" ? "a unit" : "وحدة";
  return { what, project: c.project || "—", code: c.code };
}

module.exports = {
  getDraft,
  createDraft,
  clearDraft,
  appendText,
  photoNote,
  claimLimitWarning,
  appendVoice,
  appendMedia,
  stageDraftReview,
  getStagedReview,
  invalidateStagedReview,
  reviewDraft,
  answerInstallments,
  answerOwner, answerCompound,
  commitStagedReview,
  // Contract name kept: the only commit path is the staged review.
  commitDraftToDatabase: (broker, _draft, ctx) => commitStagedReview(broker, ctx),
  commitDraftToListing: (broker, _draft, ctx) => commitStagedReview(broker, ctx),
  appendToDraft,
  MAX_IMAGES,
  DRAFT_TTL_MS
};
