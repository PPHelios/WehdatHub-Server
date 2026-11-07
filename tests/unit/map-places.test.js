// tests/unit/map-places.test.js — Map rules with no database: matching a unit's compound to a place, reading a Google Maps
// link, and checking a place before it is saved.
"use strict";

const M = require("../../domain/mapPlaces");

test("a compound is matched without the word 'compound', in English or Arabic, or by an alias", () => {
  const index = M.buildIndex([{ id: "p1", name_en: "Beverly Hills", name_ar: "بيفرلي هيلز", aliases: ["BH Sodic"] }, { id: "p2", name_en: "Mivida", aliases: [] }]);
  expect(M.matchCompound(index, "Beverly Hills Compound")).toBe("p1");
  expect(M.matchCompound(index, null, "كمبوند بيفرلي هيلز")).toBe("p1");
  expect(M.matchCompound(index, "bh sodic")).toBe("p1");
  expect(M.matchCompound(index, "Mivida")).toBe("p2");
  expect(M.matchCompound(index, "Palm Hills")).toBeNull();
  expect(M.matchCompound(index, null, null)).toBeNull();
});

test("when two places share a name, the checked one answers", () => {
  const index = M.buildIndex([{ id: "a", name_en: "Hyde Park", verified: false }, { id: "b", name_en: "Hyde Park", verified: true }]);
  expect(M.matchCompound(index, "Hyde Park")).toBe("b");
});

test("coordinates are read from Google Maps links and plain pairs; short links and places outside Egypt are refused", () => {
  expect(M.parseMapsLink("https://www.google.com/maps/place/Mivida/@30.0058,31.5377,15z/data=!3m1")).toEqual({ lat: 30.0058, lng: 31.5377 });
  expect(M.parseMapsLink("https://www.google.com/maps/place/X/data=!3m1!4b1!3d30.0202!4d31.5469")).toEqual({ lat: 30.0202, lng: 31.5469 });
  expect(M.parseMapsLink("https://maps.google.com/?q=30.1,31.6")).toEqual({ lat: 30.1, lng: 31.6 });
  expect(M.parseMapsLink("30.05, 30.94")).toEqual({ lat: 30.05, lng: 30.94 });
  expect(M.parseMapsLink("https://maps.app.goo.gl/abc123")).toEqual({ error: "short_link" });
  expect(M.parseMapsLink("https://www.google.com/maps/@48.85,2.35,12z")).toEqual({ error: "outside_egypt" });
  expect(M.parseMapsLink("hello")).toEqual({ error: "not_found" });
  expect(M.parseMapsLink("")).toEqual({ error: "empty" });
});

test("a place needs a name and Egyptian coordinates (typed or from a link); aliases become a list", () => {
  expect(M.cleanPlace({ lat: "30", lng: "31" })).toEqual({ ok: false, error: "name" });
  expect(M.cleanPlace({ name_en: "X" })).toEqual({ ok: false, error: "coords" });
  expect(M.cleanPlace({ name_en: "X", lat: "10", lng: "10" })).toEqual({ ok: false, error: "outside_egypt" });
  expect(M.cleanPlace({ name_en: "X", maps_link: "https://maps.app.goo.gl/q" })).toEqual({ ok: false, error: "link_short" });
  expect(M.cleanPlace({ name_en: "X", maps_link: "nonsense" })).toEqual({ ok: false, error: "link_unreadable" });
  const ok = M.cleanPlace({ name_en: " Mivida Compound ", name_ar: "ميفيدا", maps_link: "…@30.0058123456,31.5377,15z", aliases: "Emaar Mivida، ميفيدا إعمار", verified: "on" });
  expect(ok.ok).toBe(true);
  expect(ok.value).toMatchObject({ name_key: "mivida", name_en: "Mivida Compound", lat: 30.005812, lng: 31.5377, aliases: ["Emaar Mivida", "ميفيدا إعمار"], verified: true });
});
