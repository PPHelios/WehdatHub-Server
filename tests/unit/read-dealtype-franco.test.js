// tests/unit/read-dealtype-franco.test.js — shared deal type and Franco readers (Parser consolidation, Phase 1).
"use strict";

const { readDealType } = require("../../domain/read/dealType");
const { francoToArabic } = require("../../domain/read/franco");

describe("deal type", () => {
  test.each([
    ["شقة للبيع في التجمع", "sale"],
    ["عايز اشتري شقة", "sale"],
    ["شقة تمليك", "sale"],
    ["apartment for sale", "sale"],
    ["شقة للايجار", "rent"],
    ["شقة إيجار", "rent"],
    ["عايز استأجر شقة", "rent"],
    ["for rent 3 bedrooms", "rent"],
    ["lel egar", "rent"],
    ["lel beya3", "sale"],
    ["شقة في التجمع", null],
  ])("%s → %s", (t, v) => expect(readDealType(t).listing).toBe(v));

  test("sale and rent together are not sure", () => {
    const r = readDealType("للبيع او للايجار");
    expect(r.listing).toBeNull();
    expect(r.sure).toBe(false);
  });
  test.each([
    ["ريسيل في ميفيدا", "resale"],
    ["شقة اول سكن", "primary"],
    ["primary unit", "primary"],
    ["second hand", "resale"],
    ["شقة", null],
  ])("market %s → %s", (t, v) => expect(readDealType(t).market).toBe(v));
  test("empty", () => expect(readDealType("")).toEqual({ listing: null, market: null, sure: true }));
});

describe("franco", () => {
  test.each([
    ["3 ghorf fel tagamo3", "3 غرف في التجمع"],
    ["sha2a fel re7ab", "شقة في الرحاب"],
    ["sha2a 3 ghorf f el tagamo3 el khames", "شقة 3 غرف f التجمع الخامس"],
    ["villa 3ayez", "villa عايز"],
    ["3 melyon w nos", "3 مليون w نص"],
    ["sha2a lel egar fel ma3adi", "شقة للايجار في المعادي"],
    ["sha2a mesh mafrosha", "شقة مش مفروشة"],
  ])("%s", (t, v) => expect(francoToArabic(t).text).toBe(v));
  test("unknown words are left alone", () => {
    const r = francoToArabic("apartment in mivida min 3 bedrooms");
    expect(r.text).toBe("apartment in mivida min 3 bedrooms");
    expect(r.changed).toBe(0);
  });
  test("Arabic text is untouched", () => expect(francoToArabic("شقة 3 غرف في التجمع").changed).toBe(0));
  test("empty", () => expect(francoToArabic("").text).toBe(""));
});
