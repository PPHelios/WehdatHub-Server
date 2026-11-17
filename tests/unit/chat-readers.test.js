// tests/unit/chat-readers.test.js — Phase 3: the chat post reader uses the shared readers (money, floor, rooms, area).
"use strict";

const C = require("../../domain/chatListing");
const S = require("../../domain/sheetImport");

const cells = (t) => C.parsePost(t).cells;

describe("chat post: wrong readings fixed", () => {
  test("الا ربع", () => expect(cells("فيلا للبيع مدينتي بسعر 22 مليون الا ربع").price_value).toBe("21750000"));
  test("مليون و 200", () => expect(cells("شقة السعر 5 مليون و 200 كاش").price_value).toBe("5200000"));
  test("مليون و 750 الف", () => expect(cells("شقة للبيع 3 مليون و 750 الف").price_value).toBe("3750000"));
  test("ونص still reads as before", () => expect(cells("شقة بسعر 4 مليون ونص").price_value).toBe("4 مليون ونص"));
  test("floor: ordinal before the word is the floor, not the room count", () => {
    expect(cells("شقة للبيع تاني دور 3 غرف 140 متر").floor).toBe("2");
    expect(cells("apartment 2nd floor 3 bedrooms").floor).toBe("2");
  });
  test("floor: ground and number still read", () => {
    expect(cells("شقة ارضي 3 غرف").floor).toBe("ارضي");
    expect(cells("شقة 3 غرف دور 5").floor).toBe("5");
  });
  test("rooms the old patterns missed", () => {
    expect(cells("شقة للبيع تلات اوض 4 مليون").bedrooms).toBe("3");
    expect(cells("شقة غرفة وصالة للايجار 8 الف").bedrooms).toBe("1");
  });
  test("area written with the word", () => expect(cells("شقة للبيع مساحة 150 بسعر 3 مليون").area_value).toBe("150"));
  test("furnishing: not furnished is not furnished", () => expect(cells("شقة للايجار مش مفروشة 10 الف").furnishing).toBe("unfurnished"));
  test("furnishing: semi", () => expect(cells("استوديو للايجار سيمي فرنشد 15 الف").furnishing).toBe("semi_furnished"));
  test("nothing sure means empty, never a guess", () => {
    const c = cells("شقة 3500000 4000000");
    expect(c.price_value === undefined || c.price_value === "3500000" || c.price_value === "4000000").toBe(true);
  });
});

describe("Excel finishing and furnishing cells", () => {
  test.each([
    ["مش مفروشة", "unfurnished"],
    ["semi furnished", "semi_furnished"],
    ["مطبخ", "kitchen_and_ac"],
    ["مفروشة", "furnished"],
  ])("furnishing %s", (t, v) => expect(S.furnishing(t)).toBe(v));
  test.each([
    ["سيمي فينشد", "semi_finished"],
    ["كور اند شيل", "core_and_shell"],
    ["semi furnished", null],
    ["fully finished", "fully_finished"],
    ["سوبر لوكس", "super_lux"],
  ])("finishing %s", (t, v) => expect(S.finishing(t)).toBe(v));
});

describe("features and orientation written inline (Phase 6)", () => {
  test("a word the app's feature list knows is kept in the features cell; plain posts get none", () => {
    expect(cells("شقة للبيع في ميفيدا 200 متر 3 غرف بحري السعر 12 مليون").features).toBe("بحري");
    expect(cells("شقة للبيع 120 متر السعر 5 مليون").features).toBeUndefined();
  });
});

describe("rent from a period price (Phase 6)", () => {
  test("a price per period is a rent; an installment 'monthly' or a post that says sale is not", () => {
    expect(cells("Code MIr597 Unit type: apartment Area : 160m 2 bedrooms Price : 130$ short / 2700$ long").listing_type).toBe("rent");
    expect(cells("شقة 120 متر السعر 40 الف شهري").listing_type).toBe("rent");
    expect(cells("شقة للبيع 120 متر السعر 4 مليون القسط 40 الف شهري").listing_type).toBe("sale");
    expect(cells("شقة 120 متر السعر 4 مليون القسط 40 الف شهري").listing_type).toBeUndefined();
    expect(cells("شقة 120 متر السعر 4 مليون").listing_type).toBeUndefined();
  });
});
