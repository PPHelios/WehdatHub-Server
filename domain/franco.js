// domain/franco.js — Franco-Arabic (Arabic in Latin letters + digits) to Arabic words. Plain lexicon, no AI.
"use strict";

// Keys are lowercase whole words. "el" (the) is dropped: lexicon entries already carry the Arabic "ال" where needed.
const LEXICON = {
  sha2a: "شقه", sha2et: "شقه", shaqa: "شقه", shaqqa: "شقه", shoa2: "شقه",
  owad: "غرف", odad: "غرف", ewad: "غرف", awad: "غرف", oda: "غرفه", oda2: "غرفه", ghorf: "غرف",
  fel: "في", fil: "في", fi: "في", fee: "في", fe: "في",
  tagamo3: "التجمع", tagamoa: "التجمع", tagamo3: "التجمع",
  ta7t: "تحت", fo2: "فوق", a2al: "اقل", akter: "اكتر", aktar: "اكتر",
  mo3ayna: "معاينه", mo3aynat: "معاينات", mo3ayanat: "معاينات", m3aynat: "معاينات", mo3aynet: "معاينات",
  naharda: "النهارده", nharda: "النهارده", elnaharda: "النهارده", bokra: "بكره", embare7: "امبارح", embarah: "امبارح",
  alshahr: "الشهر", elshahr: "الشهر", shahr: "شهر", el2esbo3: "الاسبوع", esbo3: "اسبوع", da: "ده", dah: "ده", dy: "دي",
  "3omala": "عملاء", "3umala": "عملاء", "3mala": "عملاء", "3amil": "عميل", "3ameel": "عميل", "3emil": "عميل",
  mlhomsh: "ملهمش", malhomsh: "ملهمش", mlhmsh: "ملهمش", ma7dsh: "محدش", mo7dsh: "محدش", "7ad": "حد", mase3hom: "ماسكهم", masekhom: "ماسكهم",
  broker: "بروكر", brokers: "بروكرز", wasee6: "وسيط",
  fein: "فين", fen: "فين", meen: "مين", eh: "ايه", ezay: "ازاي", kam: "كام", leh: "ليه", ay: "اي", anhi: "انهي",
  et2akharet: "اتاخرت", et2akhar: "اتاخر", et2akhr: "اتاخر", fatet: "فاتت", fatetny: "فاتتني", mota2khra: "متاخره",
  mota3ba: "متابعه", mota6a3a: "متابعه", mot6ba3: "متابعه", motab3a: "متابعه", motab3at: "متابعات",
  donia: "الدنيا", "3amla": "عامله", "3amleen": "عاملين", e7na: "احنا", a7san: "احسن", ahsan: "احسن", ash6ar: "اشطر",
  tartib: "ترتيب", mas3dr: "مصدر", masdar: "مصدر", masader: "مصادر", "3amolat": "عمولات", "3omola": "عموله",
  ta2reer: "تقرير", molakhas: "ملخص", mol5as: "ملخص", saf2at: "صفقات", safa2at: "صفقات", safqa: "صفقه",
  "3o2od": "عقود", egar: "ايجار", igar: "ايجار", ejar: "ايجار", bay3: "بيع", lelbay3: "للبيع",
  milyon: "مليون", melyon: "مليون", alf: "الف", gineh: "جنيه", fila: "فيلا", dublex: "دوبلكس",
  sho8l: "شغل", "3ayez": "عايز", "3ayz": "عايز", "3ayza": "عايزه", "3andy": "عندي", "3ndy": "عندي", "3andena": "عندنا", "3ndna": "عندنا",
  lesa: "لسه", matkalemoosh: "متكلموش", men: "من", "3ala": "على", ma3: "مع", w: "و", el: "", al: "",
  esboo3: "اسبوع", gay: "الجاي", gaay: "الجاي", gai: "الجاي", elly: "اللي", ellie: "اللي", eli: "اللي", elli: "اللي",
  bnkhsar: "بنخسر", bnkhsr: "بنخسر", bnekhsar: "بنخسر", btrou7: "بتروح", btro7: "بتروح", btrooh: "بتروح",
  "2adema": "قديمه", "2adeema": "قديمه", "2adim": "قديم", wa7dat: "وحدات", wa7da: "وحده", wa7da2: "وحدات", wa7det: "وحدات", wehdat: "وحدات",
  mat7adasetsh: "متحدثتش", mat7adsh: "متحدثتش", mat7dtsh: "متحدثتش", mat7adasatsh: "متحدثتش",
  "3ayzeen": "عايزين", "3ayzin": "عايزين", "3awzeen": "عايزين", me7tageen: "محتاجين", m7tageen: "محتاجين"
};
// Words that alone do not prove the text is Franco (they are valid English/Latin on their own).
const WEAK = new Set(["fi", "fe", "fee", "fel", "fil", "da", "dah", "dy", "ay", "eh", "kam", "men", "w", "el", "al", "broker", "brokers", "million", "villa", "duplex", "alf", "leh", "meen", "fen", "fein", "shahr", "oda", "zayed", "sheikh", "dublex", "gay", "gai", "elly", "eli", "elli", "ellie"]);
const DIGIT_WORD = /[a-z]/i;

function toArabic(text) {
  const s = String(text || "");
  const toks = s.toLowerCase().split(/(\s+)/);
  const words = toks.filter((t) => t.trim()).map((t) => t.replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, ""));
  if (!words.some((w) => Object.hasOwn(LEXICON, w) && !WEAK.has(w))) return s;
  return toks
    .map((t) => {
      if (!t.trim()) return t;
      const m = t.match(/^([^a-z0-9']*)([a-z0-9'][a-z0-9']*|)([^a-z0-9']*)$/);
      if (!m || !m[2] || !DIGIT_WORD.test(m[2]) || !Object.hasOwn(LEXICON, m[2])) return t;
      return `${m[1]}${LEXICON[m[2]]}${m[3]}`;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = { LEXICON, toArabic };
