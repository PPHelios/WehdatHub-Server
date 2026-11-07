// lib/aiBlock.js — Why an AI call did not run, and what to tell the person. One place, so every screen and bot reply says
// the same true thing: the monthly credits are spent (and when they come back), the daily cap was reached, the agency
// owner switched the feature off, or the AI is not answering.
"use strict";

/** → "quota" (monthly credits) | "daily" (daily cap) | "off" (owner's switch) | "ai" (not answering) */
function kindOf(err) {
  const code = String(err?.code || "");
  if (code === "PLAN_QUOTA_EXCEEDED") return "quota";
  if (code === "BROKER_QUOTA_EXCEEDED" || code === "AGENCY_QUOTA_EXCEEDED") return "daily";
  if (code === "AI_OFF") return "off";
  if (/QUOTA/.test(code)) return "quota";
  return "ai";
}

const MONTHS_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The day the credits come back: the 1st of next month, Cairo time. */
function resetOn(lang = "ar", now = new Date()) {
  const [y, m] = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit" }).format(now).split("-").map(Number);
  const next = m === 12 ? 0 : m; // zero-based month of the next month
  return lang === "en" ? `1 ${MONTHS_EN[next]}` : `1 ${MONTHS_AR[next]}`;
}

/**
 * The words for a blocked call. role "owner" is told where to buy credits; everyone else to ask the agency owner.
 * @param {"quota"|"daily"|"off"|"ai"} kind
 */
function text(kind, lang = "ar", { owner = false, now = new Date() } = {}) {
  const en = lang === "en";
  if (kind === "quota") {
    return en
      ? `⛔ This month's AI credits are used up (they come back on ${resetOn("en", now)}). Forms, imports and basic search still work. ${owner ? "You can ask for more credits on the Plan page." : "Ask your agency owner for more credits."}`
      : `⛔ رصيد الذكاء الاصطناعي للشهر خلص (بيتجدد يوم ${resetOn("ar", now)}). الفورم والاستيراد والبحث العادي شغالين. ${owner ? "تقدر تطلب رصيد زيادة من صفحة الباقة." : "اطلب من مالك الشركة رصيد زيادة."}`;
  }
  if (kind === "daily") {
    return en
      ? "⏳ You reached today's AI limit. It resets tomorrow; this month's credits are not used up."
      : "⏳ وصلت لحد النهارده في الذكاء الاصطناعي. بيتجدد بكرة، ورصيد الشهر لسه موجود.";
  }
  if (kind === "off") {
    return en
      ? "🔒 Your agency owner switched this AI feature off. Ask them if you need it."
      : "🔒 مالك الشركة قفل الخاصية دي. اسأله لو محتاجها.";
  }
  return en ? "⚠️ The AI is not answering right now. Try again in a moment." : "⚠️ الذكاء الاصطناعي مش بيرد دلوقتي. جرب كمان شوية.";
}

module.exports = { kindOf, resetOn, text };
