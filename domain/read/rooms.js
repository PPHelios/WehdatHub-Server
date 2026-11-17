// domain/read/rooms.js — Bedrooms and bathrooms from free text (Parser consolidation, Phase 1).
// "غرفتين", "2 br", "٣ غرف نوم", "غرفة وصالة", "استوديو", "2-3 غرف", "تلات اوض", "2 bath", "حمامين".
// Returns { bedrooms, bedroomsMax, bathrooms, studio, sure } and never decides meaning (a count in search is a minimum;
// in a listing it is exact: the caller decides). sure=false when the text gives two different counts or an absurd one.
// Pure. No network, no DB.
"use strict";

const { norm, wordValue, WORD_ALT } = require("./numbers");

const NUM = `(\\d{1,2}|${WORD_ALT})`;
const BED = "(?:غرف|غرفه|اوض|اوضه|اوضتين|غرفتين|غرفتان|نوم|بيدروم\\p{L}*|bedrooms?|beds?|br|bdr?s?|bd|ghorf\\p{L}*|oda\\p{L}*|rooms?)";
const BED_PRE = "(?:bedrooms?|beds?|br|غرف|غرفه|اوض|اوضه|rooms?|عدد الغرف|عدد غرف)";
const NOT_BED = "(?:مربيه|خادمه|ملابس|دريسنج|ماستر|معيشه|سفره|ضيوف|استقبال|nanny|maid|dressing|master|living|dining|guest|reception|laundry)";
const BATH = "(?:حمام\\p{L}*|bath\\p{L}*|bth\\p{L}*|ba|wc|toilets?|دورات? ميا?ه|دوره ميا?ه)";
const END = "(?![\\p{L}\\p{N}])";
const START = "(?<![\\p{L}\\p{N}])";

const count = (tok) => {
  if (/^\d+$/.test(tok)) return Number(tok);
  const w = wordValue(tok);
  return w === null ? null : w;
};

function readRooms(text) {
  const raw = String(text ?? "");
  const out = { bedrooms: null, bedroomsMax: null, bathrooms: null, studio: false, sure: true };
  if (!raw.trim()) return out;
  const s = ` ${norm(raw).replace(/[,،;()]+/g, " ").replace(/\s+/g, " ")} `;

  if (/(?<![\p{L}])(?:استوديو|ستوديو|استديو|studio)(?![\p{L}])/u.test(s)) {
    out.studio = true;
    out.bedrooms = 0;
    out.bedroomsMax = 0;
  }

  const found = [];
  let m;
  // Range: "2-3 غرف", "من 2 الى 3 غرف", "2 to 3 bedrooms"
  m = new RegExp(`${START}(?:من |from )?(\\d{1,2}) ?(?:-|–|الي|الى|ل|to) ?(\\d{1,2}) ?${BED}${END}`, "u").exec(s);
  if (m && Number(m[1]) < Number(m[2])) {
    out.bedrooms = Number(m[1]);
    out.bedroomsMax = Number(m[2]);
  } else {
    // "3 غرف", "٣ نوم", "2 br", "تلات اوض"
    for (const x of s.matchAll(new RegExp(`${START}${NUM} ?${BED}${END}(?!(?<=غرفه|اوضه|rooms?) ?${NOT_BED})`, "gu"))) {
      const n = count(x[1]);
      if (n !== null) found.push(n);
    }
    // "bedrooms: 3", "عدد الغرف 3"
    for (const x of s.matchAll(new RegExp(`${START}${BED_PRE} ?[:=]? ?(\\d{1,2})${END}`, "gu"))) found.push(Number(x[1]));
    // "غرفتين", "اوضتين"
    if (/(?<![\p{L}])(?:غرفتين|غرفتان|اوضتين)(?![\p{L}])/u.test(s)) found.push(2);
    // "غرفة وصالة" / "غرفه و صاله": one bedroom
    if (/(?<![\p{L}])(?:غرفه|اوضه) ?و? ?صاله/u.test(s) && !found.length) found.push(1);
    // "غرفة نوم" alone is one bedroom
    if (!found.length && /(?<![\p{L}])غرفه نوم(?![\p{L}])/u.test(s)) found.push(1);
    const uniq = [...new Set(found)];
    if (uniq.length === 1) out.bedrooms = uniq[0];
    else if (uniq.length > 1) out.sure = false;
  }
  if (out.bedrooms !== null && out.bedrooms > 15) {
    out.bedrooms = null;
    out.bedroomsMax = null;
    out.sure = false;
  }

  const baths = [];
  for (const x of s.matchAll(new RegExp(`${START}${NUM} ?${BATH}${END}`, "gu"))) {
    const n = count(x[1]);
    if (n !== null) baths.push(n);
  }
  for (const x of s.matchAll(new RegExp(`${START}(?:bathrooms?|baths?|حمامات|عدد الحمامات) ?[:=] ?(\\d{1,2})${END}`, "gu"))) baths.push(Number(x[1]));
  if (/(?<![\p{L}])حمامين(?![\p{L}])/u.test(s)) baths.push(2);
  const ub = [...new Set(baths)];
  if (ub.length === 1 && ub[0] <= 15) out.bathrooms = ub[0];
  else if (ub.length > 1 || (ub.length === 1 && ub[0] > 15)) out.sure = false;
  return out;
}

module.exports = { readRooms };
