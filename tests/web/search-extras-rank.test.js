// Extras (AC, kitchen, pool...) rank results, they do not hide units whose extras were never recorded (Haytham 2026-11-12).
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const Q = require("../../domain/searchQuery");
const Search = require("../../services/search");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(() => closeHarness());

async function agencyOf(l) {
  return (await h.pool.query("SELECT agency_id FROM listings WHERE id = $1", [l.id])).rows[0].agency_id;
}
const ids = async (agency, text) => (await Search.runSearch(h.pool, agency, Q.fallbackParse(text), { pageSize: 20 })).rows.map((r) => r.code);

test("a unit with the extra comes first, a unit with no extras recorded comes after, a unit with other extras only is left out", async () => {
  const withAc = await h.insertListing({ code: "E1", compound: "Hyde Park", listing_type: "rent", bedrooms: 3, price_value: 40000 });
  await h.query("UPDATE listings SET feature_keys = ARRAY['ac_installed'] WHERE id = $1", [withAc.id]);
  await h.insertListing({ code: "E2", compound: "Hyde Park", listing_type: "rent", bedrooms: 3, price_value: 41000 });
  const other = await h.insertListing({ code: "E3", compound: "Hyde Park", listing_type: "rent", bedrooms: 3, price_value: 42000 });
  await h.query("UPDATE listings SET feature_keys = ARRAY['corner'] WHERE id = $1", [other.id]);
  const agency = await agencyOf(withAc);
  const got = await ids(agency, "apartment for rent hyde park with ac installed");
  expect(got.slice(0, 2)).toEqual(["E1", "E2"]);
  expect(got).not.toContain("E3");
});

test("a furnished unit fits a kitchen and AC request, after the exact and blank ones", async () => {
  const x = await h.insertListing({ code: "F1", compound: "Mivida", listing_type: "rent", bedrooms: 2, price_value: 30000 });
  const agency = await agencyOf(x);
  await h.query("UPDATE listings SET furnishing = 'furnished' WHERE id = $1", [x.id]);
  const blank = await h.insertListing({ code: "F2", compound: "Mivida", listing_type: "rent", bedrooms: 2, price_value: 31000 });
  const exact = await h.insertListing({ code: "F3", compound: "Mivida", listing_type: "rent", bedrooms: 2, price_value: 32000 });
  await h.query("UPDATE listings SET furnishing = 'kitchen_and_ac' WHERE id = $1", [exact.id]);
  const unf = await h.insertListing({ code: "F4", compound: "Mivida", listing_type: "rent", bedrooms: 2, price_value: 33000 });
  await h.query("UPDATE listings SET furnishing = 'unfurnished' WHERE id = $1", [unf.id]);
  void blank;
  expect(await ids(agency, "apartment for rent mivida kitchen and ac")).toEqual(["F3", "F2", "F1"]);
});
