// domain/read/floor.js — Floor from free text (Parser consolidation, Phase 1).
// "ارضي", "تاني دور", "الدور الرابع", "دور 5", "floor 3", "3rd floor", "الطابق الثالث", "اخر دور", "roof".
// Returns { floor, ground, roof, last, sure }. "شقة ارضي" is a ground-floor apartment, never a land type: this reader
// only reads the floor and leaves property types alone. Pure. No network, no DB.
"use strict";

const { norm } = require("./numbers");

const ORD = {
  اول: 1, اولي: 1, اوله: 1, first: 1, "1st": 1,
  تاني: 2, ثاني: 2, تانيه: 2, ثانيه: 2, second: 2, "2nd": 2,
  تالت: 3, ثالث: 3, تالته: 3, ثالثه: 3, third: 3, "3rd": 3,
  رابع: 4, رابعه: 4, fourth: 4, "4th": 4,
  خامس: 5, خامسه: 5, fifth: 5, "5th": 5,
  سادس: 6, سادسه: 6, sixth: 6, "6th": 6,
  سابع: 7, سابعه: 7, seventh: 7, "7th": 7,
  تامن: 8, ثامن: 8, تامنه: 8, ثامنه: 8, eighth: 8, "8th": 8,
  تاسع: 9, تاسعه: 9, ninth: 9, "9th": 9,
  عاشر: 10, عاشره: 10, tenth: 10, "10th": 10,
};
const ORD_ALT = Object.keys(ORD).sort((a, b) => b.length - a.length).join("|");
const S = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
const FLOOR_WORD = "(?:دور|الدور|طابق|الطابق|floor|fl)";

function readFloor(text) {
  const out = { floor: null, ground: false, roof: false, last: false, sure: true };
  const raw = String(text ?? "");
  if (!raw.trim()) return out;
  const s = ` ${norm(raw).replace(/[,،;()]+/g, " ").replace(/\s+/g, " ")} `;

  if (new RegExp(`${S}(?:ال)?(?:ارضي|ground(?: floor)?|gf)${E}`, "u").test(s)) {
    out.ground = true;
    out.floor = 0;
  }
  if (new RegExp(`${S}(?:روف|رووف|roof|سطح)${E}`, "u").test(s)) out.roof = true;
  if (new RegExp(`${S}(?:اخر دور|اخير|اخر طابق|الدور الاخير|last floor|top floor)${E}`, "u").test(s)) out.last = true;

  const found = new Set();
  for (const m of s.matchAll(new RegExp(`${S}${FLOOR_WORD} ?(?:ال)?(${ORD_ALT})${E}`, "gu"))) found.add(ORD[m[1]]);
  for (const m of s.matchAll(new RegExp(`${S}(?:ال)?(${ORD_ALT}) ${FLOOR_WORD}${E}`, "gu"))) found.add(ORD[m[1]]);
  // "دور 3 غرف" is three rooms, not the third floor.
  const NOT_FLOOR_NUM = "(?! ?(?:غرف|غرفه|اوض|اوضه|نوم|bed|br(?![\\p{L}])|rooms?|حمام|متر|م2|م(?![\\p{L}])|sqm|m2|bath|k(?![\\p{L}])|الف|مليون))";
  for (const m of s.matchAll(new RegExp(`${S}${FLOOR_WORD} ?[:=]? ?(\\d{1,2})${E}${NOT_FLOOR_NUM}`, "gu"))) found.add(Number(m[1]));
  for (const m of s.matchAll(new RegExp(`${S}(\\d{1,2})(?:st|nd|rd|th)? ${FLOOR_WORD}${E}`, "gu"))) found.add(Number(m[1]));
  // Only an ordinal, e.g. the whole cell says "الرابع"
  const only = new RegExp(`^ ?(?:ال)?(${ORD_ALT}) ?$`, "u").exec(s);
  if (only) found.add(ORD[only[1]]);

  const list = [...found];
  if (out.ground) list.push(0);
  const uniq = [...new Set(list)];
  if (uniq.length === 1) out.floor = uniq[0];
  else if (uniq.length > 1) {
    out.floor = null;
    out.sure = false;
  }
  if (out.floor !== null && out.floor > 60) {
    out.floor = null;
    out.sure = false;
  }
  return out;
}

module.exports = { readFloor };
