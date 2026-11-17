// tests/unit/read-amount.test.js — shared money reader (Parser consolidation, Phase 1).
"use strict";

const { readAmount, readAmounts } = require("../../domain/read/amount");
const { norm, toAsciiDigits, wordValue } = require("../../domain/read/numbers");

const v = (t) => readAmount(t)?.value;

describe("amount reader: the known wrong readings are fixed", () => {
  test.each([
    ["٣ ونص مليون", 3500000],
    ["5 مليون الا ربع", 4750000],
    ["٣ مليون إلا ربع", 2750000],
    ["7 مليون و 200", 7200000],
    ["بـ 3.5 م", 3500000],
    ["1,5 مليون", 1500000],
    ["3 مليون و 750 الف", 3750000],
    ["استوديو 60م 15 الف", 15000],
  ])("%s", (text, value) => expect(v(text)).toBe(value));
});

describe("amount reader: wider phrasing", () => {
  test.each([
    ["3.5 مليون", 3500000],
    ["٣٫٥ مليون", 3500000],
    ["450 الف", 450000],
    ["450 ألف", 450000],
    ["8.500.000", 8500000],
    ["1,500,000", 1500000],
    ["5.5م", 5500000],
    ["3 mn", 3000000],
    ["2m", 2000000],
    ["3 million", 3000000],
    ["مليونين", 2000000],
    ["مليونين ونص", 2500000],
    ["نص مليون", 500000],
    ["ربع مليون", 250000],
    ["مليون ونص", 1500000],
    ["تلاتة مليون ونص", 3500000],
    ["5 ملايين جنيه", 5000000],
    ["15 الف", 15000],
    ["1.500 مليون", 1500000],
    ["450.000", 450000],
    ["3500000 في التجمع", 3500000],
  ])("%s", (text, value) => expect(v(text)).toBe(value));

  test("currency", () => {
    expect(readAmount("$250000").currency).toBe("USD");
    expect(readAmount("3 مليون يورو").currency).toBe("EUR");
    expect(readAmount("3 مليون").currency).toBe("EGP");
  });
});

describe("amount reader: things that are not money", () => {
  test.each(["شقة 3 غرف", "120 متر", "10%", "01012345678", "الدور 5", "كود 4500", "خمسة غرف", "3 سنين"])("%s → null", (t) =>
    expect(readAmount(t)).toBeNull(),
  );
  test("room count next to a price", () => expect(v("شقة 3 غرف 450000")).toBe(450000));
  test("metres next to a price", () => expect(v("شقة 120 متر 3 مليون")).toBe(3000000));
  test("room after 'و' does not join the price", () => expect(v("3 مليون و 2 غرف")).toBe(3000000));
});

describe("amount reader: sure flag", () => {
  test("clear unit is sure", () => expect(readAmount("3.5 مليون").sure).toBe(true));
  test("one bare number is sure", () => expect(readAmount("3500000").sure).toBe(true));
  test("two bare numbers are not sure", () => {
    const all = readAmounts("3500000 4000000");
    expect(all).toHaveLength(2);
    expect(all.every((a) => a.sure === false)).toBe(true);
  });
  test("bare number right after a unit amount is not sure", () => {
    const all = readAmounts("3 مليون 200");
    expect(all[0].sure).toBe(true);
    expect(all[1].sure).toBe(false);
  });
  test("unknown word right after a bare number is not sure", () => expect(readAmount("3500000 xyzq").sure).toBe(false));
  test("lone م with a mid-size integer is not sure", () => expect(readAmount("15م").sure).toBe(false));
  test("empty input", () => {
    expect(readAmount("")).toBeNull();
    expect(readAmount(null)).toBeNull();
    expect(readAmounts(undefined)).toEqual([]);
  });
});

describe("numbers helpers", () => {
  test("digits", () => expect(toAsciiDigits("٣٫٥ ۴")).toBe("3.5 4"));
  test("norm folds Arabic letters", () => expect(norm("إلا غرفة أَلف")).toBe("الا غرفه الف"));
  test("number words", () => {
    expect(wordValue("تلاتة")).toBe(3);
    expect(wordValue("ثلاثة")).toBe(3);
    expect(wordValue("خمسين")).toBe(50);
    expect(wordValue("بيت")).toBeNull();
  });
});
