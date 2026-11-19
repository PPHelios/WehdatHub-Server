// lib/ownerAlerts.js — The CRM owner's gate for the app's own alerts (Telegram and the notification centre). Each kind of
// alert belongs to a category with a severity. The owner can switch a category off, or ask for only the more serious ones
// (minSeverity). Stored app-level in app_settings key "owner_alerts": { off: [ids], minSeverity }. Default: all on, everything.
// allowed() never throws: on any error the alert is sent (a missed alert costs more than an extra one).
"use strict";

const SEVERITIES = ["high", "medium", "low"];
const RANK = { high: 3, medium: 2, low: 1 };
const KEY = "owner_alerts";
const CACHE_MS = 30 * 1000;

/** id, severity, labels (ar, en), what it covers (ar, en). All are on by default. */
const CATEGORIES = [
  { id: "errors", severity: "high", ar: "أعطال في التطبيق", en: "App errors", on: true },
  { id: "ai", severity: "high", ar: "الذكاء الاصطناعي بيفشل أو مصروفه زاد", en: "AI failing or spending too much", on: true },
  { id: "payments", severity: "high", ar: "مدفوعات مستنية أو اتبلّغ عنها", en: "Payments waiting or announced", on: true },
  { id: "security", severity: "high", ar: "محاولات دخول فاشلة وتصدير كتير", en: "Failed sign-ins and heavy exports", on: true },
  { id: "credits", severity: "medium", ar: "رصيد شركة قرب يخلص وطلبات رصيد", en: "Credits nearly used and credit requests", on: true },
  { id: "new_trial", severity: "medium", ar: "تجربة جديدة وطلبات عرض", en: "New trials and demo requests", on: true },
  { id: "bug_reports", severity: "medium", ar: "بلاغات ومقترحات من البروكرز", en: "Bug reports and suggestions", on: true },
  { id: "lead_intake", severity: "medium", ar: "ربط فيسبوك وقف أو هادي", en: "Facebook lead link stopped or quiet", on: true },
  { id: "read_cap", severity: "medium", ar: "حد القراءة اليومي اتعدّى", en: "Daily read limit reached", on: true },
  { id: "storage", severity: "low", ar: "صور مش مستخدمة في التخزين", en: "Unused photo files in storage", on: true },
  { id: "places", severity: "low", ar: "أماكن جديدة مستنية موافقتك", en: "New places waiting for approval", on: true },
  { id: "failures_digest", severity: "low", ar: "ملخص الأعطال اليومي", en: "Daily failures summary", on: true },
  { id: "search_audit", severity: "low", ar: "فحص البحث بالليل", en: "Nightly search check", on: true }
];
const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));
const SEVERITY_LABELS = { high: ["عالية", "High"], medium: ["متوسطة", "Medium"], low: ["بسيطة", "Low"] };

const DEFAULTS = Object.freeze({ off: [], minSeverity: "low" });
let cache = null; // { at, value }

/** A stored value cleaned: only known ids, a known severity. */
function clean(v) {
  const off = [...new Set([].concat(v?.off ?? []).map(String))].filter((id) => BY_ID.has(id));
  return { off, minSeverity: SEVERITIES.includes(v?.minSeverity) ? v.minSeverity : "low" };
}

function invalidate() {
  cache = null;
}

/** The saved settings ({ off, minSeverity }), cached for 30 seconds. */
async function get(pool, { now = Date.now() } = {}) {
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  const Billing = require("../services/billing");
  const value = clean(await Billing.getSetting(pool, KEY, DEFAULTS));
  cache = { at: now, value };
  return value;
}

async function save(pool, input) {
  const Billing = require("../services/billing");
  const value = clean(input);
  await Billing.setSetting(pool, KEY, value);
  invalidate();
  return value;
}

/** Pure rule: may an alert of this category be sent under these settings? Unknown categories are always sent. */
function permits(settings, categoryId) {
  const c = BY_ID.get(categoryId);
  if (!c) return true;
  const s = clean(settings);
  if (s.off.includes(c.id)) return false;
  return RANK[c.severity] >= RANK[s.minSeverity];
}

/** true when the owner wants this category. Never throws: an error means "send it". */
async function allowed(pool, categoryId) {
  try {
    if (!pool || !BY_ID.has(categoryId)) return true;
    return permits(await get(pool), categoryId);
  } catch {
    return true;
  }
}

module.exports = { CATEGORIES, SEVERITIES, SEVERITY_LABELS, DEFAULTS, KEY, get, save, allowed, permits, clean, invalidate };
