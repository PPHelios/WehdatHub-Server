// services/projectAnswer.js — Ask answers from the project catalog when no unit matches a project's name. The answer uses the
// project's stored details and the lines of its notes that mention what was asked (a price, an area), and says when the data
// was last updated. Commission and plan rules are never read here.
"use strict";

const { normalizeSearch } = require("../domain/searchText");
const { normalizeDigits } = require("../lib/text");

// Words that name a kind of place or unit, not a project: they must not match every project.
const GENERIC = new Set(
  [
    "ريزيدنس", "ريزدنس", "ريزيدنسز", "كمبوند", "كومبوند", "مشروع", "شقه", "شقة", "وحده", "وحدة", "عايز", "عاوز", "دور", "في", "فى", "من", "على", "عن",
    "متر", "مربع", "بدور", "ابحث", "هل", "فيه", "عندكم", "residence", "residences", "compound", "project", "apartment", "unit", "the", "in", "of",
    "for", "with", "sqm", "meter", "meters", "and", "or", "a", "an", "any", "under", "over", "budget", "installment", "installments", "قسط", "اقساط", "أقساط",
    "تقسيط", "مقدم", "ميزانيه", "ميزانية", "سعر", "بكام", "كام"
  ].map(normalizeSearch)
);

/** Words of the request that could name a project: letters only, at least three, not generic, not numbers. */
function nameWords(text) {
  const t = normalizeSearch(normalizeDigits(String(text || "")));
  return [...new Set(t.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !GENERIC.has(w)))];
}

/** The numbers the request names (110, 150 ...), used to pick the note lines that mention them. */
function requestNumbers(text) {
  return [...new Set((normalizeDigits(String(text || "")).match(/\d+(?:\.\d+)?/g) || []).map((n) => String(Number(n))))];
}

/** Projects whose Arabic or English name contains one of the request's words (accents and spelling variants folded). */
function matchProjects(projects, words) {
  if (!words.length) return [];
  const hits = [];
  for (const p of projects) {
    const names = [p.name, p.name_en].map((n) => normalizeSearch(n || ""));
    const score = words.filter((w) => names.some((n) => n.includes(w))).length;
    if (score) hits.push({ project: p, score });
  }
  return hits.sort((a, b) => b.score - a.score).map((h) => h.project);
}

/**
 * The note lines that answer the request. Lines are split where the notes separate offers (a line break, "__", or the fire emoji).
 * With numbers in the request, only the lines that mention one of them. Without numbers, the lines that name a payment plan.
 */
function noteLines(notes, numbers) {
  const parts = String(notes || "")
    .split(/\n|__|🔥/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 3);
  if (numbers.length) {
    const hit = parts.filter((s) => numbers.some((n) => new RegExp(`(^|[^\\d.])${n.replace(".", "\\.")}([^\\d]|$)`).test(normalizeDigits(s))));
    return hit.slice(0, 6);
  }
  return parts.filter((s) => /مقدم|تقسيط|قسط|payment|down/i.test(s)).slice(0, 3);
}

function formatDate(d) {
  if (!d) return null;
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? null : x.toISOString().slice(0, 10);
}

/** The reply text for one project, or null when the words name no project. */
function projectReply(project, text, lang = "ar") {
  const en = lang === "en";
  const lines = noteLines(project.notes, requestNumbers(text));
  const updated = formatDate(project.updated_at);
  const head = [
    `🏗️ *${project.name_en || project.name}*${project.name_en && project.name ? ` (${project.name})` : ""}`,
    project.developer_name ? (en ? `Developer: ${project.developer_name}` : `المطور: ${project.developer_name}`) : null,
    [project.district, project.city].filter(Boolean).length ? (en ? `Area: ${[project.district, project.city].filter(Boolean).join(", ")}` : `المنطقة: ${[project.district, project.city].filter(Boolean).join("، ")}`) : null,
    project.status || project.delivery_year
      ? en
        ? `Status: ${project.status || "-"}${project.delivery_year ? ", delivery " + project.delivery_year : ""}`
        : `الحالة: ${project.status || "-"}${project.delivery_year ? "، التسليم " + project.delivery_year : ""}`
      : null
  ].filter(Boolean);
  const body = lines.length
    ? [en ? "From the project notes:" : "من ملاحظات المشروع:", ...lines.map((l) => `• ${l}`)]
    : [en ? "The project notes have nothing on that yet." : "ملاحظات المشروع مفيهاش حاجة عن ده لسه."];
  const foot = [
    en
      ? "No units of this project are in the inventory yet, so this answer comes from the project catalog."
      : "مفيش وحدات للمشروع ده في المخزون لسه، فالرد ده من بيانات المشروع في الكتالوج.",
    updated ? (en ? `Last updated: ${updated}` : `آخر تحديث: ${updated}`) : en ? "Last updated: not recorded" : "آخر تحديث: غير مسجل"
  ];
  return [...head, "", ...body, "", ...foot].join("\n");
}

/**
 * Ask's catalog answer for a request that found no unit. Returns the reply text, or null when no project matches.
 * `text` is the request as typed; the project list is the agency's own, unarchived projects.
 */
async function answer(pool, agencyId, text, lang = "ar") {
  const words = nameWords(text);
  if (!words.length || !pool) return null;
  const { rows } = await pool.query(
    "SELECT name, name_en, developer_name, district, city, status, delivery_year, notes, updated_at FROM projects WHERE agency_id = $1 AND archived_at IS NULL",
    [agencyId]
  );
  const [best] = matchProjects(rows, words);
  if (!best) return null;
  return projectReply(best, text, lang);
}

module.exports = { answer, nameWords, requestNumbers, matchProjects, noteLines, projectReply };
