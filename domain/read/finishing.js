// domain/read/finishing.js — Free text → one fixed finishing status (Parser consolidation, Phase 1).
// core_and_shell, semi_finished, fully_finished, super_lux, ultra_super_lux. A bare "تشطيب" or "لوكس" says nothing sure → null.
// "semi furnished" is a furnishing word, never a finishing one. Pure. No network, no DB.
"use strict";

const { norm } = require("./numbers");

const FURN = /فرش|مفروش|فرنش|فيرنش|furnish|furniture/;
const ULTRA = /(?:ultra super lux|ultra lux|الترا سوبر لو?ك?س|الترا سوبر لكس|الترا لو?ك?س|الترا لكس|الترا سوبر لوكس)/;
const SUPER = /(?:super ?lux|سوبر ?لو?ك?س|سوبر ?لكس)/;
const NOT_FINISHED = /(?:مش|غير|بدون|من غير|لم يتم|لسه|not|non|un|without) ?(?:ال)?(?:متشطب\w*|تشطيب|finish\w*)/;
const SEMI = /(?:سيمي|semi|نص|نصف|half) ?(?:فينش\w*|فينيش\w*|finish\w*|تشطيب|متشطب\w*)/;
const CORE = /(?:core ?(?:and|&|n|\+)? ?shell|كور ?(?:اند|و|&)? ?(?:شيل|شل)|كور شيل|\bshell\b|محاره|علي الطوب|على الطوب|طوب احمر|عالمحاره)/;
const FULL = /(?:fully ?finish\w*|full ?finish\w*|\bfinished\b|فول ?فين\w*|تشطيب كامل|كامل التشطيب|متشطب\w*|فينيش|فيني[شس])/;

function readFinishing(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { value: null, sure: true };
  const t = ` ${norm(raw).replace(/[-_/,.،()]+/g, " ").replace(/\s+/g, " ").trim()} `;
  if (ULTRA.test(t)) return { value: "ultra_super_lux", sure: true };
  if (SUPER.test(t)) return { value: "super_lux", sure: true };
  if (SEMI.test(t)) return { value: "semi_finished", sure: true };
  // "semi" alone counts as semi-finished only when the text has no furnishing word.
  if (/\bsemi\b|سيمي/.test(t) && !FURN.test(t)) return { value: "semi_finished", sure: true };
  if (CORE.test(t) || NOT_FINISHED.test(t)) {
    if (FULL.test(t.replace(NOT_FINISHED, " "))) return { value: null, sure: false };
    return { value: "core_and_shell", sure: true };
  }
  if (FULL.test(t)) return { value: "fully_finished", sure: true };
  return { value: null, sure: true };
}

module.exports = { readFinishing };
