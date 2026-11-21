// lib/unitPhase.js — The phase a unit is filed under (a sub-zone of type phase, e.g. Madinaty B10), for the app and the web.
"use strict";

/** { phase, phaseEn }: the phase's name in Arabic and English, nulls when the unit has no phase. */
async function phaseOf(pool, subzoneId) {
  if (!subzoneId) return { phase: null, phaseEn: null };
  const { rows } = await pool.query("SELECT name_ar, name_en FROM areas WHERE id = $1 AND place_type = 'phase'", [subzoneId]);
  const r = rows[0];
  return { phase: r ? r.name_ar || r.name_en : null, phaseEn: r ? r.name_en || r.name_ar : null };
}

module.exports = { phaseOf };
