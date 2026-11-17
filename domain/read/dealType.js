// domain/read/dealType.js — Sale or rent, and primary or resale, from free text (Parser consolidation, Phase 1).
// "للبيع", "ايجار", "for rent", "عايز اشتري", "استأجر", "ريسيل", "اول سكن", "lel beya3", "egar".
// Returns { listing: "sale" | "rent" | null, market: "primary" | "resale" | null, sure }.
// Both sale and rent words in one text → listing null and sure false (never guess). Pure. No network, no DB.
"use strict";

const { norm } = require("./numbers");

const S = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
const RENT = `${S}(?:لل|ل)?(?:ايجار|ايجارات|استئجار|استاجر|اتاجر|تاجير|rent|rental|rents|lease|egar|igar|eygar|ejar|2egar|ijar)${E}`;
const SALE = `${S}(?:لل|ل)?(?:بيع|للبيع|اشتري|شراء|تمليك|sale|sell|buy|bay3|beya3|bai3|bei3|2eshtery|eshtery|ashtary)${E}`;
const PRIMARY = `${S}(?:برايمري|primary|اول سكن|من المطور|من الشركه|فرست هاند|first hand|developer)${E}`;
const RESALE = `${S}(?:ريسيل|resale|re sale|اعاده بيع|مستعمل|سكند هاند|second hand|من المالك)${E}`;

function readDealType(text) {
  const out = { listing: null, market: null, sure: true };
  const raw = String(text ?? "");
  if (!raw.trim()) return out;
  const s = ` ${norm(raw).replace(/[-_/,.،()]+/g, " ").replace(/\s+/g, " ").trim()} `;
  const rent = new RegExp(RENT, "u").test(s);
  const sale = new RegExp(SALE, "u").test(s);
  if (rent && sale) out.sure = false;
  else if (rent) out.listing = "rent";
  else if (sale) out.listing = "sale";
  const pri = new RegExp(PRIMARY, "u").test(s);
  const res = new RegExp(RESALE, "u").test(s);
  if (pri && res) out.sure = false;
  else if (pri) out.market = "primary";
  else if (res) out.market = "resale";
  return out;
}

module.exports = { readDealType };
