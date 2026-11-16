// tests/unit/rent-price-check.test.js — scripts/rent-price-check.js lists rent units priced like a year or a sale (the
// "HP310 rent, 13.5 million per month" case); yearly rents and normal monthly rents are left alone.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { suspicious } = require("../../scripts/rent-price-check");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

test("a rent over the limit a month is listed; yearly, normal and sale units are not", async () => {
  await h.insertListing({ code: "HP-310", listing_type: "rent", price_value: 13500000 });
  await h.insertListing({ code: "HP-311", listing_type: "rent", price_value: 13500000, details: { rent_period: "yearly" } });
  await h.insertListing({ code: "HP-312", listing_type: "rent", price_value: 45000 });
  await h.insertListing({ code: "HP-313", listing_type: "sale", price_value: 13500000 });
  const rows = await suspicious(h.pool);
  expect(rows.map((r) => r.code)).toEqual(["HP-310"]);
  expect(Number(rows[0].price)).toBe(13500000);
  expect(rows[0].period).toBe("monthly");
});

test("the limit and the agency can be chosen", async () => {
  await h.insertListing({ code: "HP-320", listing_type: "rent", price_value: 600000 });
  expect(await suspicious(h.pool, { limit: 1000000 })).toEqual([]);
  expect((await suspicious(h.pool, { limit: 500000 })).map((r) => r.code)).toEqual(["HP-320"]);
  expect(await suspicious(h.pool, { limit: 500000, agencyId: h.AGENCY_B })).toEqual([]);
});
