// tests/unit/place-suggest-shared.test.js — The place matching rules give the same answers as the phone's copy.
// The same fixture (tests/fixtures/place-suggest.json) is checked by the app's own test, so a change on one side fails the other.
"use strict";

const A = require("../../domain/areas");
const fx = require("../fixtures/place-suggest.json");

test.each(fx.cases.map((c) => [c.q, c.expect]))("suggest %j", (q, expected) => {
  expect(A.suggest(q, { places: fx.places, areas: fx.areas }, 8).map((r) => r.id)).toEqual(expected);
});
