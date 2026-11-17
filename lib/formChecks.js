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
  if (isNew && !normalizePhone(phone)) {
    // A typed number that is not an Egyptian mobile says so; an empty one is just needed.
    out.push(phone ? item(lang, "owner_phone", "تليفون المالك: مش موبايل مصري صحيح (01xxxxxxxxx)", "Owner phone: not a valid Egyptian mobile (01xxxxxxxxx)") : item(lang, "owner_phone", "تليفون المالك", "Owner phone"));
  }
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

// The form field that holds what the person typed for a blocker's field.
const RAW_OF = { price_value: "price_value", monthly_rent: "price_value", area_value: "area_value", bua: "area_value", bedrooms: "bedrooms", bathrooms: "bathrooms", floor: "floor_level", land_area: "land_area" };
const AMOUNT = new Set(["price_value", "monthly_rent"]);

/**
 * A blocker for a value the person typed but the form could not read ("abc" as a price, 99 bedrooms) says what is wrong
 * ("Price: not a valid amount"); a blocker for an empty field keeps its plain name, which reads as "needed".
 * Shared by the website and the app's API, so both show the same words.
 */
function explainInvalid(blockers, body, lang) {
  return (blockers || []).map((b) => {
    const raw = RAW_OF[b.field];
    const typed = raw && body && body[raw] !== undefined && body[raw] !== null && String(Array.isArray(body[raw]) ? body[raw].join("") : body[raw]).trim() !== "";
    if (!typed) return b;
    const why = AMOUNT.has(b.field) ? L10n(lang, "مش مبلغ صحيح", "not a valid amount") : L10n(lang, "مش رقم صحيح", "not a valid number");
    const whyEn = AMOUNT.has(b.field) ? "not a valid amount" : "not a valid number";
    const whyAr = AMOUNT.has(b.field) ? "مش مبلغ صحيح" : "مش رقم صحيح";
    return { ...b, label_ar: `${b.label_ar}: ${whyAr}`, label_en: `${b.label_en}: ${whyEn}`, label: `${lang === "en" ? b.label_en : b.label_ar}: ${why}` };
  });
}

module.exports = { ownerBlockers, changesOf, explainInvalid };
