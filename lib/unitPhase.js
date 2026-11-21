// lib/unitPhase.js — The phase a unit is filed under (a sub-zone of type phase, e.g. Madinaty B10), for the app and the web.
"use strict";

/** SQL columns: the phase's name in Arabic and English (null when the unit has no phase). Used in every unit list and detail query. */
const PHASE_NAME_COLS = `(SELECT a.name_ar FROM areas a WHERE a.id = listings.subzone_id AND a.place_type = 'phase') AS phase_ar,
  (SELECT a.name_en FROM areas a WHERE a.id = listings.subzone_id AND a.place_type = 'phase') AS phase_en`;

/** { phase, phaseEn }: the phase's name in Arabic and English, nulls when the unit has no phase. */
async function phaseOf(pool, subzoneId) {
  if (!subzoneId) return { phase: null, phaseEn: null };
  const { rows } = await pool.query("SELECT name_ar, name_en FROM areas WHERE id = $1 AND place_type = 'phase'", [subzoneId]);
  const r = rows[0];
  return { phase: r ? r.name_ar || r.name_en : null, phaseEn: r ? r.name_en || r.name_ar : null };
}

/**
 * The phases to offer for a unit's place, as the unit box shows them: { base, list: [{id, label, selected}] }, or null when the
 * place has no phases. Same rule as domain/phases.js: a phase's siblings, or a place's own phases; base is the sub-zone a tap on
 * the chosen phase goes back to (empty when the place is a top-level area).
 */
async function phasesOf(pool, subzoneId, areaId, lang = "ar") {
  const node = subzoneId || areaId;
  if (!node) return null;
  const { rows: [n] } = await pool.query("SELECT id, parent_id, place_type FROM areas WHERE id = $1", [node]);
  if (!n) return null;
  const isPhase = n.place_type === "phase";
  const parentId = isPhase ? n.parent_id : n.id;
  if (!parentId) return null;
  const { rows: found } = await pool.query("SELECT id, name_ar, name_en FROM areas WHERE parent_id = $1 AND place_type = 'phase'", [parentId]);
  if (!found.length) return null;
  const { rows: [parent] } = await pool.query("SELECT parent_id FROM areas WHERE id = $1", [parentId]);
  // Numbered phases first (B1 … B15), then the named ones; numbers in natural order.
  const numbered = (s) => (/\d/.test(s) ? 1 : 0);
  const list = found
    .map((r) => ({ id: r.id, label: lang === "en" ? r.name_en || r.name_ar : r.name_ar || r.name_en, selected: isPhase && r.id === n.id }))
    .sort((a, b) => numbered(b.label) - numbered(a.label) || a.label.localeCompare(b.label, "en", { numeric: true }));
  return { base: parent && parent.parent_id ? parentId : "", list };
}

/** The unit's phase fields for the app's edit screen: phase_label (the unit's own phase) and place_phases (JSON), both "" when none. */
async function editPhaseFields(pool, listing, lang = "ar") {
  const pp = await phasesOf(pool, listing.subzone_id, listing.area_id, lang);
  const sel = pp ? pp.list.find((x) => x.selected) : null;
  return { phase_label: sel ? sel.label : "", place_phases: pp ? JSON.stringify(pp) : "" };
}

module.exports = { PHASE_NAME_COLS, phaseOf, phasesOf, editPhaseFields };
