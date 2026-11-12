// lib/formChecks.js — What the final save also refuses, as blockers, and what an edit is about to change. Shared by the
// website form and the app so both show the same list before anything is saved.
"use strict";

const { normalizePhone } = require("../domain/phone");

const L10n = (lang, ar, en) => (lang === "en" ? en : ar);
const item = (lang, field, ar, en) => ({ field, label_ar: ar, label_en: en, label: L10n(lang, ar, en) });

/**
 * The owner's phone (a new unit needs it) and name (needed with a phone, or always for a new unit; the "use the phone as
 * the name" tick clears it).
 * @param {Object} listing - composed listing (details.owner_name / owner_phone)
 * @param {Object} body - the submitted fields (owner_name_from_phone)
 */
function ownerBlockers(listing, body, lang, { isNew }) {
  const d = (listing && listing.details) || {};
  const phone = String(d.owner_phone || "").trim();
  const tick = ["1", "true", "on", "yes"].includes(String((body && body.owner_name_from_phone) ?? ""));
  const out = [];
  if (isNew && !normalizePhone(phone)) out.push(item(lang, "owner_phone", "تليفون المالك", "Owner phone"));
  if (!String(d.owner_name || "").trim() && (isNew || phone) && !tick) {
    out.push(item(lang, "owner_name", "اسم المالك (أو علّم \"استخدم التليفون كاسم\")", "Owner name (or tick \"use the phone as the name\")"));
  }
  return out;
}

const CHANGE_FIELDS = [["price_value", "السعر", "Price"], ["area_value", "المساحة", "Area"], ["bedrooms", "الغرف", "Bedrooms"], ["bathrooms", "الحمامات", "Bathrooms"], ["compound", "الكمبوند", "Compound"], ["listing_type", "بيع/إيجار", "Sale/rent"], ["property_type", "النوع", "Type"], ["finishing", "التشطيب", "Finishing"], ["floor_level", "الدور", "Floor"]];

/** An edit's main fields that differ, as { field, ar, en, from, to }. */
function changesOf(existing, next) {
  if (!existing || !next) return [];
  const show = (v) => (v === null || v === undefined || v === "" ? "—" : String(v));
  return CHANGE_FIELDS.filter(([f]) => show(existing[f]) !== show(next[f])).map(([field, ar, en]) => ({ field, ar, en, from: show(existing[field]), to: show(next[field]) }));
}

module.exports = { ownerBlockers, changesOf };
