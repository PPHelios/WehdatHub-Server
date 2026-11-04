// domain/furnishingStatus.js — Free text (Arabic or English, typed, extracted or imported) → one fixed furnishing status.
// Fixed statuses: furnished, semi_furnished, unfurnished, kitchen_and_ac, ac_only, kitchen_only (Haytham 2026-11-04).
// Furnished-type words win over kitchen and AC: "مفروشة مع مطبخ وتكييف" is furnished. The word "بس" is optional.
"use strict";

const { normalizeSearch } = require("./searchText");

const FURNISHING_STATUSES = ["furnished", "semi_furnished", "unfurnished", "kitchen_and_ac", "ac_only", "kitchen_only"];
const FINISHING_STATUSES = ["core_and_shell", "semi_finished", "fully_finished", "super_lux", "ultra_super_lux"];

const KITCHEN = /مطبخ|kitchen/;
const AC = /تكييف|تكيف|مكيف|تكيفات|\bac\b|\bacs\b|a c\b|air condition/;

/** The one fixed status for a free-text furnishing, or null when the text says nothing about furnishing. */
function mapFurnishing(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  if (FURNISHING_STATUSES.includes(raw)) return raw;
  const t = ` ${normalizeSearch(raw)} `;
  // Semi-furnished before furnished: "نص مفروشة" contains "مفروشه".
  if (/ (نص|نصف|semi|half) (فرش|مفروش|مفروشه|مفروشة|furnished|furnish)/.test(t) || / (نص|نصف) /.test(t) && /فرش|مفروش|furnish/.test(t)) return "semi_furnished";
  if (/ (بدون فرش|بدون مفروش|بدون مفروشه|غير مفروش|غير مفروشه|فاضي|فاضيه|فاضية|فضي|unfurnished|empty|bare) /.test(t) || /\bunfurnished\b/.test(t)) return "unfurnished";
  if (/مفروش|فرش كامل|فيرنشد|فرنشد|furnish/.test(t)) return "furnished";
  const k = KITCHEN.test(t);
  const a = AC.test(t);
  if (k && a) return "kitchen_and_ac";
  if (a) return "ac_only";
  if (k) return "kitchen_only";
  return null;
}

/** The one fixed finishing status for free text, or null. */
function mapFinishing(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  if (FINISHING_STATUSES.includes(raw)) return raw;
  const t = ` ${normalizeSearch(raw)} `;
  if (/ultra super lux|ultra lux|الترا سوبر لوكس|الترا لوكس|الترا سوبر لكس/.test(t)) return "ultra_super_lux";
  if (/super lux|سوبر لوكس|سوبر لكس|سوبر لوكس/.test(t)) return "super_lux";
  if (/semi|نص تشطيب|نصف تشطيب|نص تشطيب/.test(t)) return "semi_finished";
  if (/core|shell|محاره|محارة|بدون تشطيب|على الطوب|علي الطوب/.test(t)) return "core_and_shell";
  if (/fully finished|fully finish|finished|تشطيب كامل|متشطب|فينيش|فيني/.test(t)) return "fully_finished";
  return null;
}

module.exports = { FURNISHING_STATUSES, FINISHING_STATUSES, mapFurnishing, mapFinishing };
