// domain/phases.js — Compound phases (Madinaty B6, Rehab phase 7) as rules, no database. A phase is a sub-zone (`areas` row with
// place_type 'phase') under the area or sub-zone a compound sits in. The list lives in data/areas/compound-phases.json; nothing
// here names a compound. A phase is read from text by its own names and aliases ("b6", "مرحلة 7") together with its parent's
// name, in any order. Only a code in the phase's own name (B6, VG3: letters then digits) or a zone with no number in its name
// (Privado, The Spine) may stand alone; every other alias is generic ("مرحلة 7", "phase 1", "سادسة", "م1") and counts only when
// the parent compound or area is named in the same text. A group (Rehab 1 = phases 1-5) is a list of phases one alias stands for.
"use strict";

const A = require("./areas");
const { placeKey, keysOf } = require("./mapPlaces");

const isPhase = (a) => Boolean(a) && a.place_type === "phase";

const numbered = (a) => (/\d/.test(String(a.name_en || a.name_ar)) ? 1 : 0); // numbered zones first (B1, B2, VG1…), named zones after

/**
 * The phases to offer for a chosen node: its phase children, or its sibling phases when the node is itself a phase.
 * @returns {{ phases: object[], selected: string|null }} phases sorted by name (natural order), selected = the node when it is a phase
 */
function phasesFor(areas, nodeId) {
  const node = areas.find((a) => a.id === nodeId);
  if (!node) return { phases: [], selected: null };
  const parentId = isPhase(node) ? node.parent_id : node.id;
  const phases = areas.filter((a) => a.parent_id === parentId && isPhase(a)).sort((a, b) => numbered(b) - numbered(a) || String(a.name_en || a.name_ar).localeCompare(String(b.name_en || b.name_ar), "en", { numeric: true }));
  return { phases, selected: isPhase(node) ? node.id : null };
}

const has = (hay, key) => Boolean(key) && hay.includes(` ${key} `);

/** Keys that may resolve a phase with no parent named: the letters+digits codes of its own name, or every key of a zone with no digit in its name. */
function bareKeys(phase) {
  const name = String(phase.name_en || "");
  if (!/\d/.test(name)) return new Set(keysOf(phase));
  return new Set(placeKey(name).split(" ").filter((w) => /^[a-z]+\d+$/.test(w)));
}

/**
 * The one phase a text names, or null. Rules: a phase's key (its name or an alias) must be in the text as whole words, and either its
 * parent (the area or sub-zone, or a compound standing on it) is named too, or the key leads to this phase only.
 * @param {string} text
 * @param {{places?: object[], areas: object[]}} lists approved rows
 * @returns {{ phase: object, words: string[], named: boolean }|null} words = the words the phase's key used (not place words any more); named = its parent was named too
 */
function findPhase(text, { places = [], areas = [] }) {
  const phases = areas.filter(isPhase);
  if (!phases.length) return null;
  const hay = ` ${placeKey(text)} `;
  if (hay.trim().length < 2) return null;
  const owners = new Map(); // key -> phase ids
  for (const p of phases) for (const k of keysOf(p)) owners.set(k, [...(owners.get(k) || []), p.id]);
  const parentNamed = (p) => {
    const parent = areas.find((a) => a.id === p.parent_id);
    if (!parent) return false;
    if (keysOf(parent).some((k) => k.length >= 3 && has(hay, k))) return true;
    return places.some((c) => (c.subzone_id || c.area_id) === parent.id && keysOf(c).some((k) => k.length >= 3 && has(hay, k)));
  };
  const hits = [];
  for (const p of phases) {
    const named = parentNamed(p);
    for (const k of keysOf(p)) {
      if (!has(hay, k)) continue;
      if (!named && !(owners.get(k).length === 1 && bareKeys(p).has(k))) continue;
      hits.push({ phase: p, key: k, named });
    }
  }
  if (!hits.length) return null;
  const best = Math.max(...hits.map((h) => h.key.length));
  const top = hits.filter((h) => h.key.length === best);
  if (new Set(top.map((h) => h.phase.id)).size !== 1) return null;
  return { phase: top[0].phase, words: top[0].key.split(" "), named: top.some((h) => h.named) };
}

/**
 * A group alias in the text ("Rehab 1", "الرحاب الامتداد"): the phases it stands for, or null. An alias that holds a name of the group's parent
 * stands alone; a generic one ("الامتداد", "extension") needs the parent named too.
 * @param {Array<{parent: string, aliases: string[], phases: string[]}>} groups from data/areas/compound-phases.json
 * @returns {{ ids: string[], words: string[] }|null}
 */
function findGroup(text, { areas = [], places = [] }, groups = []) {
  const hay = ` ${placeKey(text)} `;
  let best = null;
  for (const g of groups) {
    const parent = areas.find((a) => placeKey(a.name_en) === placeKey(g.parent));
    if (!parent) continue;
    const pKeys = [...keysOf(parent), ...places.filter((c) => (c.subzone_id || c.area_id) === parent.id).flatMap(keysOf)].filter((k) => k.length >= 3);
    const named = pKeys.some((k) => has(hay, k));
    for (const alias of g.aliases) {
      const k = placeKey(alias);
      if (!has(hay, k) || !(named || pKeys.some((p) => has(` ${k} `, p)))) continue;
      if (!best || k.length > best.key.length) best = { key: k, ids: areas.filter((a) => a.parent_id === parent.id && isPhase(a) && g.phases.includes(a.name_en)).map((a) => a.id) };
    }
  }
  return best && best.ids.length ? { ids: best.ids, words: best.key.split(" ") } : null;
}

/**
 * The compound a phase belongs to, when the text names one that stands on the phase's parent; else null.
 */
function compoundOf(phase, places, text) {
  const hay = ` ${placeKey(text)} `;
  return places.find((c) => (c.subzone_id || c.area_id) === phase.parent_id && keysOf(c).some((k) => k.length >= 3 && has(hay, k))) || null;
}

module.exports = { isPhase, phasesFor, findPhase, findGroup, compoundOf };
