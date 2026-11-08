// domain/projectClarify.js — Questions for the manager about a project's notes: lines with a price that could not be read,
// and offers that disagree. Pure. Answering is optional; saving a project is never blocked by these.
"use strict";

const { normalizeDigits } = require("../lib/text");
const { parseUnits } = require("./projectNotes");

const MAX_QUESTIONS = 5;

const CLARIFIED = /^\d{4}-\d{2}-\d{2}\s+توضيح/;
const ref = (line) => clean(line).slice(0, 60);
const clean = (s) => s.replace(/\s+/g, " ").trim();
const lines = (notes) => normalizeDigits(String(notes || "")).split(/\n|__|🔥/).map(clean).filter((s) => s.length > 3);

/** Up to 5 questions: { kind: "unread"|"conflict", line, question: {ar, en} }. Lines already answered ("توضيح:") are skipped. */
function findIssues(notes) {
  const units = parseUnits(notes);
  const read = new Set(units.map((u) => u.raw));
  const out = [];
  const all = lines(notes);
  const answered = all.filter((l) => CLARIFIED.test(l));
  const isAnswered = (line) => answered.some((a) => a.includes(`«${ref(line)}»`));
  for (const line of all) {
    if (read.has(line) || CLARIFIED.test(line) || isAnswered(line)) continue;
    // A number that looks like a price (6+ digits once commas are removed) on a line no offer could be read from.
    if (/\d{1,3}(?:[,٬]\d{3}){2,}|[1-9]\d{2}[,٬]\d{3}(?!\d)|\d{6,}/.test(line)) {
      out.push({
        kind: "unread",
        line,
        question: { ar: `مقدرتش أفهم السطر ده: «${line}». إيه المساحة والسعر والمقدم والقسط؟`, en: `I could not read this line: "${line}". What are the area, price, down payment and installment?` }
      });
    }
  }
  const seen = new Map();
  for (const u of units) {
    const key = `${u.area}|${u.floor || ""}`;
    const prev = seen.get(key);
    if (prev && prev.price !== u.price && !isAnswered(u.raw)) {
      out.push({
        kind: "conflict",
        line: u.raw,
        question: {
          ar: `في عرضين لنفس الوحدة (${u.area} م) بسعرين مختلفين: ${prev.price.toLocaleString("en-US")} و ${u.price.toLocaleString("en-US")}. أنهي الصح؟`,
          en: `Two offers for the same unit (${u.area} m²) have different prices: ${prev.price.toLocaleString("en-US")} and ${u.price.toLocaleString("en-US")}. Which is right?`
        }
      });
    } else seen.set(key, u);
  }
  return out.slice(0, MAX_QUESTIONS);
}

/** The dated line saved into the notes for a manager's answer. */
function answerLine(day, line, answer) {
  return `${day} توضيح عن «${ref(String(line || ""))}»: ${clean(String(answer || "")).slice(0, 300)}`;
}

module.exports = { findIssues, answerLine, MAX_QUESTIONS };
