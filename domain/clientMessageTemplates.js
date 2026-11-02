// domain/clientMessageTemplates.js — The placeholder text behind each "ⓘ" tip beside a WhatsApp send on the lead page.
// Pure: the three client messages (viewing time, follow-up draft, unit details) in both languages, with {placeholders}
// for what each send fills in. A line whose value is missing is left out when the real message is built, so the tip
// says so once.
"use strict";

const TEMPLATES = {
  ar: {
    viewing: "أهلاً {اسم العميل الأول}،\nميعاد المعاينة: {التاريخ والوقت}\n🏠 {الوحدة}\n📍 {المكان}\nأكّد أو اختار ميعاد تاني من هنا: {رابط التأكيد}\n— {اسم الوسيط}\n\nلو الاسم مش مسجل: «أهلاً بحضرتك». السطور الفاضية بتتشال.",
    draft: "{اسم العميل الأول}، رسالة قصيرة (جملتين لـ 4) من آخر مكالمة أو معاينة وملاحظات الوسيط وطلب العميل. مش بتذكر أسعار أو مواعيد مش مسجلة.",
    unit: "🏠 {الوحدة} · كود {الكود}\n🏷️ {النوع والمكان والمساحة}\n💰 {السعر}\n📝 {الوصف}\n🔗 الصور والتفاصيل: {رابط المشاركة}\n— {اسم الوسيط}\n\nالسطور الفاضية بتتشال."
  },
  en: {
    viewing: "Hello {client's first name},\nYour viewing: {date and time}\n🏠 {unit}\n📍 {place}\nConfirm or pick another time here: {confirm link}\n— {broker's name}\n\nIf the name is not saved: \"Hello,\". Empty lines are left out.",
    draft: "{client's first name}, a short message (2 to 4 sentences) from the last call or viewing, the broker's notes and the client's request. It never mentions prices or dates that are not on record.",
    unit: "🏠 {unit} · code {code}\n🏷️ {type, place and area}\n💰 {price}\n📝 {description}\n🔗 Photos and details: {share link}\n— {broker's name}\n\nEmpty lines are left out."
  }
};

/** The tip text for one message in one language: { viewing, draft, unit }. */
function templatesFor(lang = "ar") {
  return TEMPLATES[lang === "en" ? "en" : "ar"];
}

module.exports = { templatesFor };
