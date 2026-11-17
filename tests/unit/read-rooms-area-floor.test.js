// tests/unit/read-rooms-area-floor.test.js — shared rooms, area and floor readers (Parser consolidation, Phase 1).
"use strict";

const { readRooms } = require("../../domain/read/rooms");
const { readArea } = require("../../domain/read/area");
const { readFloor } = require("../../domain/read/floor");

describe("rooms", () => {
  test.each([
    ["شقة 3 غرف", 3],
    ["٣ غرف نوم", 3],
    ["غرفتين", 2],
    ["2 br", 2],
    ["2br", 2],
    ["3 bedrooms", 3],
    ["bedrooms: 4", 4],
    ["تلات اوض", 3],
    ["غرفة وصالة", 1],
    ["غرفتين وصالة", 2],
    ["3 غرف و 2 حمام", 3],
    ["3 غرف مربية", 3],
    ["شقة 120 متر 3 نوم", 3],
    ["3 ghorf", 3],
  ])("bedrooms %s → %s", (t, n) => expect(readRooms(t).bedrooms).toBe(n));

  test("studio is 0 bedrooms and flagged", () => {
    const r = readRooms("استوديو للبيع");
    expect(r.studio).toBe(true);
    expect(r.bedrooms).toBe(0);
  });
  test("range", () => {
    const r = readRooms("2-3 غرف");
    expect([r.bedrooms, r.bedroomsMax]).toEqual([2, 3]);
  });
  test("nanny room is not a bedroom count", () => expect(readRooms("غرفة مربية").bedrooms).toBeNull());
  test.each([
    ["2 حمام", 2],
    ["حمامين", 2],
    ["3 bath", 3],
    ["2 bathrooms", 2],
  ])("bathrooms %s → %s", (t, n) => expect(readRooms(t).bathrooms).toBe(n));
  test("two different counts are not sure", () => {
    const r = readRooms("3 غرف و 4 غرف");
    expect(r.sure).toBe(false);
    expect(r.bedrooms).toBeNull();
  });
  test("absurd count is dropped", () => expect(readRooms("40 غرف").bedrooms).toBeNull());
  test("empty", () => expect(readRooms("").bedrooms).toBeNull());
});

describe("area", () => {
  test.each([
    ["150 متر", 150],
    ["150م", 150],
    ["150 sqm", 150],
    ["مساحة 150", 150],
    ["150 م2", 150],
  ])("plain %s → %s", (t, n) => expect(readArea(t).plain).toBe(n));

  test("land and built-up apart", () => {
    const r = readArea("450 sqm land, 380 BUA");
    expect([r.land, r.built]).toEqual([450, 380]);
  });
  test("cue before the number", () => {
    const r = readArea("ارض 450 مباني 380");
    expect([r.land, r.built]).toEqual([450, 380]);
  });
  test("range", () => {
    const r = readArea("100-150 متر");
    expect([r.min, r.max]).toEqual([100, 150]);
  });
  test("a price is not an area", () => {
    expect(readArea("3.5 م").plain).toBeNull();
    expect(readArea("بـ 4 م").plain).toBeNull();
    expect(readArea("3 مليون").plain).toBeNull();
    expect(readArea("3 غرف").plain).toBeNull();
  });
  test("studio 60م 15 الف", () => expect(readArea("استوديو 60م 15 الف").plain).toBe(60));
});

describe("floor", () => {
  test.each([
    ["شقة ارضي", 0],
    ["الدور الأرضي", 0],
    ["ground floor", 0],
    ["تاني دور", 2],
    ["الدور الرابع", 4],
    ["دور 5", 5],
    ["floor 3", 3],
    ["3rd floor", 3],
    ["الطابق الثالث", 3],
    ["الرابع", 4],
    ["دور تالت", 3],
  ])("%s → %s", (t, n) => expect(readFloor(t).floor).toBe(n));

  test("ground flag", () => expect(readFloor("شقة ارضي").ground).toBe(true));
  test("last and roof", () => {
    expect(readFloor("اخر دور").last).toBe(true);
    expect(readFloor("روف").roof).toBe(true);
  });
  test("two different floors are not sure", () => {
    const r = readFloor("دور 2 دور 3");
    expect(r.floor).toBeNull();
    expect(r.sure).toBe(false);
  });
  test("no floor", () => expect(readFloor("شقة 3 غرف").floor).toBeNull());
});
