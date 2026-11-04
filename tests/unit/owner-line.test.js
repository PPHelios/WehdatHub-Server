// tests/unit/owner-line.test.js — domain/ownerLine.js: the owner written on one line of a unit draft
"use strict";

const { parseOwnerLine } = require("../../domain/ownerLine");

test("an owner line reads the name and the phone, in English or Arabic", () => {
  expect(parseOwnerLine(["Owner: Mohamed 01065358746"])).toEqual({ name: "Mohamed", phone: "201065358746" });
  expect(parseOwnerLine(["المالك محمد 01065358746"])).toEqual({ name: "محمد", phone: "201065358746" });
  expect(parseOwnerLine(["مالك: محمد ١٠٦٥٣٥٨٧٤٦"])).toEqual({ name: "محمد", phone: "201065358746" });
  expect(parseOwnerLine(["Owner Mohamed +20 106 535 8746"])).toEqual({ name: "Mohamed", phone: "201065358746" });
});

test("a line without a phone or a name is unit text, not an owner", () => {
  expect(parseOwnerLine(["مالك الوحدة مستعجل"])).toBeNull();
  expect(parseOwnerLine(["Owner: nobody"])).toBeNull();
  expect(parseOwnerLine(["Owner: 01065358746"])).toBeNull();
});

test("the owner line can sit among other draft lines, and dashes around the name are dropped", () => {
  const found = parseOwnerLine(["3 bedrooms, 120 m", "المالك أحمد - 01012345678"]);
  expect(found).toEqual({ name: "أحمد", phone: "201012345678" });
});
