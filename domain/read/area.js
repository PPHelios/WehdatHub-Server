// domain/read/area.js — Areas from free text, land apart from built-up (Parser consolidation, Phase 1).
// "150 متر", "150م", "مساحة 150", "BUA 380", "450 sqm land, 380 BUA", "ارض 450 مباني 380", "100-150 متر".
// Returns { built, land, plain, min, max, sure }. A lone "م" after a decimal or a price cue is millions, not metres
// (same rule as amount.js). Pure. No network, no DB.
"use strict";

const { norm } = require("./numbers");

const S = "(?<![\\p{L}\\p{N}.,])";
const UNIT = "(?:متر مربع|متر|م2|م²|m2|m²|sqm|sq\\.? ?m|square meters?|meters?|metres?|م|m)";
const E = "(?![\\p{L}\\p{N}²])";
const LAND = "(?:land(?: area)?|plot|ارض|مساحه الارض|مساحه ارض)";
const BUILT = "(?:bua|bue|built ?up(?: area)?|built|مباني|مبانى|بناء|مساحه المباني|مساحه البناء)";
const AREA_CUE = "(?:مساحه|المساحه|area|space)";
const NOT_AREA_AFTER = /^ ?(?:مليون|ملايين|الف|الاف|million|mn|k|غرف|غرفه|اوض|حمام|دور|طابق|سنه|سنين|%)/u;

function readArea(text) {
  const out = { built: null, land: null, plain: null, min: null, max: null, sure: true };
  const raw = String(text ?? "");
  if (!raw.trim()) return out;
  const s = ` ${norm(raw).replace(/[;()]+/g, " ").replace(/\s+/g, " ")} `;

  // Range: "100-150 متر"
  const rg = new RegExp(`${S}(\\d{2,5}) ?(?:-|–|الي|الى|to) ?(\\d{2,5}) ?${UNIT}${E}`, "u").exec(s);
  if (rg && Number(rg[1]) < Number(rg[2])) {
    out.min = Number(rg[1]);
    out.max = Number(rg[2]);
  }

  const cands = [];
  const NUMTOK = "(\\d{1,5}(?:[.,]\\d+)?)";
  // number first: "450 sqm land", "380 BUA", "150 متر", "150م"
  for (const m of s.matchAll(new RegExp(`${S}${NUMTOK} ?(${UNIT})?${E}`, "gu"))) {
    const num = Number(m[1].replace(",", "."));
    if (!Number.isFinite(num) || num < 10) continue;
    const idx = m.index;
    const end = idx + m[0].length;
    const after = s.slice(end);
    const before = s.slice(Math.max(0, idx - 22), idx);
    if (NOT_AREA_AFTER.test(after) && !m[2]) continue;
    let unit = m[2] || null;
    const isDecimal = /[.,]\d/.test(m[1]);
    if (unit && /^(m|م)$/.test(unit) && (isDecimal || /(?:^|\s)(?:ب|بسعر|سعر|price|budget|ميزانيه|حتي|حتى|max)\s*$/.test(before))) continue;
    const hasCue = new RegExp(`${AREA_CUE} ?[:=]? ?$`, "u").test(before);
    const cueB = (re) => new RegExp(`${re} ?[:=]? ?$`, "u").test(before);
    const cueA = (re) => new RegExp(`^ ?(?:${UNIT} )?${re}${E}`, "u").test(after);
    // A cue just before the number wins; a cue after it counts only when none stands before.
    const kind = cueB(BUILT) ? "built" : cueB(LAND) ? "land" : cueA(BUILT) ? "built" : cueA(LAND) ? "land" : "plain";
    const nearLand = kind === "land";
    const nearBuilt = kind === "built";
    if (!unit && !hasCue && !nearLand && !nearBuilt) continue;
    cands.push({ num, kind: nearBuilt ? "built" : nearLand ? "land" : "plain" });
  }
  const pick = (k) => {
    const v = [...new Set(cands.filter((c) => c.kind === k).map((c) => c.num))];
    if (v.length > 1) out.sure = false;
    return v.length === 1 ? v[0] : null;
  };
  out.built = pick("built");
  out.land = pick("land");
  out.plain = pick("plain");
  return out;
}

module.exports = { readArea };
