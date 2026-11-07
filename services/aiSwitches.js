// services/aiSwitches.js — The agency owner's switches for AI features: one per feature, grouped in tabs, and one master
// switch per tab. A feature works only when its own switch and its tab's master switch are both on. Everything starts on.
// Stored in agencies.crm_settings.ai_switches = { tabs: { voice: false }, features: { ask: false } }; the older photo
// ordering key (crm_settings.ai_photo_order) stays the photo_order switch. Enforced in one place, the AI gateway (lib/ai.js).
"use strict";

const TABS = [
  { id: "voice", ar: "الصوت", en: "Voice" },
  { id: "written", ar: "الكتابة والمساعدة", en: "Written help" },
  { id: "documents", ar: "المستندات والصور", en: "Documents and photos" },
  { id: "search", ar: "البحث", en: "Search" }
];

const FEATURES = [
  { key: "voice_unit_add", tab: "voice", ar: "إضافة وحدة بفويس نوت", en: "Add a unit by voice note" },
  { key: "voice_search", tab: "voice", ar: "البحث بالصوت", en: "Voice search" },
  { key: "voice_clients", tab: "voice", ar: "العملاء وتحديثاتهم بالصوت", en: "Clients and updates by voice" },
  { key: "voice_catalogue", tab: "voice", ar: "تعديلات الكتالوج بالصوت", en: "Catalogue changes by voice" },
  { key: "unit_fill", tab: "written", ar: "املأ بيانات الوحدة من وصف مكتوب", en: "Fill a unit from a written description" },
  { key: "clients_text", tab: "written", ar: "العملاء وتحديثاتهم بالكتابة", en: "Clients and updates by text" },
  { key: "ask", tab: "written", ar: "اسأل (إجابات من بيانات الشركة)", en: "Ask (answers from the agency's data)" },
  { key: "follow_up", tab: "written", ar: "رسايل المتابعة المكتوبة", en: "Written follow-up messages" },
  { key: "brochure_lines", tab: "written", ar: "أهم نقاط البروشور", en: "Brochure highlights" },
  { key: "catalogue_sentence", tab: "written", ar: "تعديلات الكتالوج بجملة", en: "Catalogue changes by sentence" },
  { key: "doc_reads", tab: "documents", ar: "قراءة PDF وصور الأسعار والأنظمة والبروشور", en: "Reading PDFs and photos (prices, plans, brochures)" },
  { key: "chat_import", tab: "documents", ar: "استيراد وحدات من شات الجروب", en: "Import units from a group chat" },
  { key: "photo_order", tab: "documents", ar: "ترتيب صور الفلاير", en: "Flyer photo ordering" },
  { key: "search_ai", tab: "search", ar: "مساعدة الذكاء الاصطناعي في البحث لما القراءة السريعة مش متأكدة", en: "AI help when the quick reader is unsure" }
];

/** Which feature each AI route belongs to (voice and text variants of extraction are told apart by the caller). */
const ROUTE_FEATURE = {
  search_parse: "search_ai",
  vision_curation: "photo_order",
  lead_extraction: "clients_text",
  lead_update: "clients_text",
  listing_extraction: "unit_fill",
  catalogue_update: "catalogue_sentence",
  price_list_read: "doc_reads",
  brochure_read: "doc_reads",
  plans_read: "doc_reads",
  gallery_read: "doc_reads",
  brochure_highlights: "brochure_lines",
  assistant: "ask",
  follow_up_draft: "follow_up"
};
/** The voice variant of a route, used when the request carries a voice note. */
const VOICE_FEATURE = { lead_extraction: "voice_clients", lead_update: "voice_clients", listing_extraction: "voice_unit_add", catalogue_update: "voice_catalogue" };

const tabOf = (key) => FEATURES.find((f) => f.key === key)?.tab || null;

/** The feature a gateway call belongs to: the caller's own (ctx.feature) wins, then the route (voice variant for audio). */
function featureFor(operationType, { audio = false, feature = null } = {}) {
  if (feature) return feature;
  if (audio && VOICE_FEATURE[operationType]) return VOICE_FEATURE[operationType];
  return ROUTE_FEATURE[operationType] || null;
}

/** Whether a feature (or, with only a tab, that tab's master switch) is on in these agency settings. */
function allowed(settings, key, { tab = null } = {}) {
  const sw = settings?.ai_switches || {};
  const t = tab || tabOf(key);
  if (t && sw.tabs?.[t] === false) return false;
  if (!key) return true;
  if (key === "photo_order" && settings?.ai_photo_order === false) return false;
  return sw.features?.[key] !== false;
}

// A short cache: the gateway asks on every AI call. Saving clears it.
const cache = new Map();
const TTL_MS = 15000;

async function settingsOf(db, agencyId) {
  const hit = cache.get(agencyId);
  if (hit && hit.until > Date.now()) return hit.settings;
  const { rows } = await db.query("SELECT crm_settings FROM agencies WHERE id = $1", [agencyId]);
  const settings = rows[0]?.crm_settings || {};
  cache.set(agencyId, { settings, until: Date.now() + TTL_MS });
  return settings;
}

/** Everything the page needs: { tabs: [{ id, on, features: [{ key, on }] }] }. */
async function forAgency(db, agencyId) {
  const s = await settingsOf(db, agencyId);
  return {
    settings: s,
    tabs: TABS.map((t) => ({
      ...t,
      on: s.ai_switches?.tabs?.[t.id] !== false,
      features: FEATURES.filter((f) => f.tab === t.id).map((f) => ({ ...f, on: allowed(s, f.key, { tab: "__none__" }) }))
    }))
  };
}

/** Keys of the features switched off for this agency (their own switch or their tab's). */
async function offList(db, agencyId) {
  if (!agencyId) return [];
  const s = await settingsOf(db, agencyId);
  return FEATURES.filter((f) => !allowed(s, f.key)).map((f) => f.key);
}

/** Whether one feature works for this agency now (its switch and its tab's). */
async function isOn(db, agencyId, key) {
  return allowed(await settingsOf(db, agencyId), key);
}

/** Throws AI_OFF when the feature (or only its tab, for a voice note with no feature of its own) is switched off. */
async function assertOn(db, agencyId, key, { tab = null } = {}) {
  if (!agencyId) return;
  if (!allowed(await settingsOf(db, agencyId), key, { tab })) {
    const err = new Error("This AI feature is switched off by the agency owner");
    err.code = "AI_OFF";
    err.feature = key || tab;
    throw err;
  }
}

/** The agency owner saves the switches: tabs on/off and each feature on/off. → { ok } | { error: "forbidden" } */
async function save(db, actor, body = {}) {
  if (String(actor?.role || "").toLowerCase() !== "owner") return { error: "forbidden" };
  const tabs = {};
  for (const t of TABS) tabs[t.id] = body[`tab_${t.id}`] === "on";
  const features = {};
  for (const f of FEATURES) features[f.key] = body[`f_${f.key}`] === "on";
  await db.query(
    `UPDATE agencies SET crm_settings = crm_settings || jsonb_build_object('ai_switches', $2::jsonb, 'ai_photo_order', $3::boolean) WHERE id = $1`,
    [actor.agency_id, JSON.stringify({ tabs, features }), features.photo_order]
  );
  cache.delete(actor.agency_id);
  return { ok: true };
}

const clearCache = () => cache.clear();

module.exports = { TABS, FEATURES, ROUTE_FEATURE, tabOf, featureFor, allowed, forAgency, offList, isOn, assertOn, save, clearCache };
