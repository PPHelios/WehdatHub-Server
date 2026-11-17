// domain/read/franco.js — Franco-Arabic (Arabic typed in Latin letters) → Arabic-equivalent tokens (Parser consolidation, Phase 1).
// "3 ghorf fel tagamo3" → "3 غرف في التجمع". Whole-word dictionary only: a word that is not in the list is left
// untouched, never guessed (a wrong place is worse than a missed one). The lists grow from the weekly review (Phase 5).
// Pure. No network, no DB.
"use strict";

// Longest phrases first. Keys are lower case, digits inside words are Franco letters (3=ع, 7=ح, 5=خ, 2=ء, 6=ط, 9=ق).
const PHRASES = [
  ["ghorfa morabeya", "غرفه مربيه"],
  ["ghorfa morabbya", "غرفه مربيه"],
  ["ghorfa morabia", "غرفه مربيه"],
  ["ghorfet morabeya", "غرفه مربيه"],
  ["ghurfa morabeya", "غرفه مربيه"],
  ["oda morabeya", "غرفه مربيه"],
  ["ghorfa nanny", "غرفه مربيه"],
  ["el tagamo3 el khames", "التجمع الخامس"],
  ["tagamo3 el khames", "التجمع الخامس"],
  ["tagamoa el khames", "التجمع الخامس"],
  ["new cairo", "التجمع"],
  ["sheikh zayed", "الشيخ زايد"],
  ["sheikh zaid", "الشيخ زايد"],
  ["6 october", "اكتوبر"],
  ["6th of october", "اكتوبر"],
  ["6 oct", "اكتوبر"],
  ["nasr city", "مدينة نصر"],
  ["madinet nasr", "مدينة نصر"],
  ["masr el gedida", "مصر الجديدة"],
  ["ain sokhna", "العين السخنة"],
  ["el sokhna", "العين السخنة"],
  ["north coast", "الساحل الشمالي"],
  ["sahel", "الساحل"],
  ["nos tashteeb", "نص تشطيب"],
  ["nos tashteb", "نص تشطيب"],
  ["tashteeb kamel", "تشطيب كامل"],
  ["tashteb kamel", "تشطيب كامل"],
  ["mesh mafrosha", "مش مفروشة"],
  ["mesh mafroosh", "مش مفروشة"],
  ["mish mafrosha", "مش مفروشة"],
  ["lel beya3", "للبيع"],
  ["lel bay3", "للبيع"],
  ["lil bay3", "للبيع"],
  ["lel egar", "للايجار"],
  ["lel igar", "للايجار"],
  ["lel eygar", "للايجار"],
  ["lil egar", "للايجار"],
  ["fel", "في"],
  ["fi el", "في"],
  ["3ala", "على"],
  ["a5er dor", "اخر دور"],
];
const WORDS = {
  tagamo3: "التجمع", tagamoa: "التجمع", tagamo: "التجمع", tagamu3: "التجمع", tagammo3: "التجمع",
  re7ab: "الرحاب", rehab: "الرحاب", rehab_city: "الرحاب",
  ma3adi: "المعادي", maadi: "المعادي", madinaty: "مدينتي", madinty: "مدينتي",
  zayed: "زايد", october: "اكتوبر", oct: "اكتوبر", shorouk: "الشروق", sherouk: "الشروق", obour: "العبور",
  mostakbal: "المستقبل", mostaqbal: "المستقبل", zamalek: "الزمالك", heliopolis: "مصر الجديدة",
  mohandseen: "المهندسين", mohandessin: "المهندسين", dokki: "الدقي", garden_city: "جاردن سيتي",
  ghorf: "غرف", ghorfa: "غرفة", ghorfet: "غرف", ghurfa: "غرفة", ghoraf: "غرف", oda: "غرفة", odaa: "غرفة", odat: "غرف", oda2: "غرفة",
  sha2a: "شقة", shaqa: "شقة", shaqqa: "شقة", sheqa: "شقة", sha22a: "شقة", sha2et: "شقة",
  villa: "فيلا", vila: "فيلا", fela: "فيلا", duplex: "دوبلكس", penthouse: "بنتهاوس", studio: "استوديو",
  tashteeb: "تشطيب", tashteb: "تشطيب", takmeel: "تشطيب", mafrosha: "مفروشة", mafroosha: "مفروشة", mafrosh: "مفروش",
  hamam: "حمام", "7amam": "حمام", "7amamat": "حمامات", hammam: "حمام", hamamat: "حمامات",
  melyon: "مليون", milyon: "مليون", meleon: "مليون", melion: "مليون", alf: "الف", elf: "الف",
  nos: "نص", noss: "نص", rob3: "ربع", rob2: "ربع", telt: "تلت",
  beya3: "بيع", bay3: "بيع", egar: "ايجار", igar: "ايجار", eygar: "ايجار", ejar: "ايجار",
  dor: "دور", dawr: "دور", dour: "دور", ar2y: "ارضي", ardy: "ارضي", ardi: "ارضي", roof: "روف",
  garage: "جراج", garden: "جاردن", teras: "تراس", terrace: "تراس", balcony: "بلكونة", pool: "حمام سباحة",
  mesh: "مش", mish: "مش", ta7t: "تحت", ta7et: "تحت", fo2: "فوق", fawq: "فوق",
  "3ayez": "عايز", "3ayz": "عايز", "3ayza": "عايزة", ayez: "عايز", ayzah: "عايزة", me7tag: "محتاج", mehtag: "محتاج", ma7tag: "محتاج",
  "3and": "عند", ana: "انا", aw: "او", lel: "لل", fe: "في", fi: "في", fel: "في",
  masr: "مصر", "3ashan": "عشان", "5eyar": "خيار", "7elw": "حلو", "3ala": "على", "3la": "على",
};
// Franco-looking Latin words that already mean the same in the Arabic vocabulary: leave them alone.
const KEEP = new Set(["bedroom", "bedrooms", "apartment", "villa", "studio", "rent", "sale", "for", "in", "the", "and", "with", "br", "bath"]);

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const PHRASE_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${PHRASES.map((p) => escape(p[0])).join("|")})(?![\\p{L}\\p{N}])`, "giu");
const PHRASE_MAP = new Map(PHRASES);

/** Franco words and phrases in the text → Arabic; everything else is kept as it was. Returns { text, changed }. */
function francoToArabic(text) {
  const raw = String(text ?? "");
  let changed = 0;
  const lower = raw.toLowerCase();
  let out = lower.replace(PHRASE_RE, (m) => {
    changed++;
    return PHRASE_MAP.get(m.toLowerCase());
  });
  out = out.replace(/(?<![\p{L}\p{N}_])[a-z0-9_]+(?![\p{L}\p{N}_])/giu, (w) => {
    if (KEEP.has(w)) return w;
    const hit = WORDS[w];
    if (hit === undefined) return w;
    changed++;
    return hit;
  });
  return { text: changed ? out : raw, changed };
}

module.exports = { francoToArabic };
