// domain/projectNames.js — Spelling-proof project name matching, pure. A project is found when a distinctive word of its
// name (Arabic or English) has the same key as a word of the question, so "ريزيدنس" and "ريزدنس", or "Jazeel" and "Jezel",
// are the same word. Words every project shares ("residence", "new") do not identify one, and a word must be spelled with
// at least three letters to count.
"use strict";

const { normalizeSearch } = require("./searchText");

// Words that name a kind of place, not a project: they never identify one.
const GENERIC = new Set(
  ["residence", "residences", "residency", "compound", "project", "resort", "ريزيدنس", "ريزدنس", "ريزيدنسز", "كمبوند", "كومبوند", "مشروع", "بروجكت", "ريزورت"].map((w) => normalizeSearch(w))
);

// A key shared by more than this many projects is a common word (like "park"), not a name.
const MAX_SPREAD = 3;

/** Spelling-proof key of one word: no leading ال, vowels and weak letters removed, repeats collapsed. */
function skeleton(word) {
  return normalizeSearch(word).replace(/^ال/, "").replace(/[اويىهةأإآءئؤaeiou]/g, "").replace(/(.)\1+/g, "$1");
}

/** The words of a text as { word, key }: 3+ letters, not a number, with a usable key (3+ letters, or from a 4+ letter word). */
function keyedWords(text) {
  return normalizeSearch(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w))
    .map((w) => ({ word: w, key: skeleton(w) }))
    .filter((x) => x.key.length >= 3 || (x.word.length >= 4 && x.key.length >= 2));
}

const distinctive = (text) => keyedWords(text).filter((x) => !GENERIC.has(x.word)).map((x) => x.key);

/**
 * Projects (with name and name_en) whose distinctive name words match words of the text. Best match first: more matching
 * words, then the larger share of the project's own words.
 */
function fuzzyMatch(text, projects) {
  const asked = new Set(distinctive(text));
  if (!asked.size) return [];
  const keyed = projects.map((p) => ({ p, keys: new Set([p.name, p.name_en].filter(Boolean).flatMap(distinctive)) }));
  const spread = new Map();
  for (const { keys } of keyed) for (const k of keys) spread.set(k, (spread.get(k) || 0) + 1);
  return keyed
    .map(({ p, keys }) => {
      const own = [...keys].filter((k) => (spread.get(k) || 0) <= MAX_SPREAD);
      const hit = own.filter((k) => asked.has(k)).length;
      return { p, hit, share: own.length ? hit / own.length : 0 };
    })
    .filter((x) => x.hit > 0)
    .sort((a, b) => b.hit - a.hit || b.share - a.share)
    .map((x) => x.p);
}

module.exports = { skeleton, keyedWords, fuzzyMatch };
