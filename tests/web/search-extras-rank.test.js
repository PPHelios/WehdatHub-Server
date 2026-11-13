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

const mk = async (code, furnishing, extra = {}) => {
  const l = await h.insertListing({ code, compound: "Mivida", listing_type: "rent", bedrooms: 2, price_value: 30000 + Number(code.slice(1)), ...extra });
  if (furnishing) await h.query("UPDATE listings SET furnishing = $2 WHERE id = $1", [l.id, furnishing]);
  return l;
};

test('"with AC" lists AC only first, then kitchen and AC, then furnished, then units with nothing recorded', async () => {
  const first = await mk("A1", "ac_only");
  await mk("A2", "kitchen_and_ac");
  await mk("A3", "furnished");
  await mk("A4", null);
  await mk("A5", "unfurnished");
  await mk("A6", "kitchen_only");
  const agency = await agencyOf(first);
  expect(await ids(agency, "apartment for rent mivida with ac")).toEqual(["A1", "A2", "A3", "A4"]);
});

test('"with kitchen" lists kitchen only first, then kitchen and AC', async () => {
  const first = await mk("K1", "kitchen_only");
  await mk("K2", "kitchen_and_ac");
  await mk("K3", "ac_only");
  const agency = await agencyOf(first);
  expect(await ids(agency, "apartment for rent mivida with kitchen")).toEqual(["K1", "K2"]);
});

test('"kitchen and ac" lists that status first, then AC only or kitchen only, then furnished and semi-furnished, then blank', async () => {
  const first = await mk("B1", "kitchen_and_ac");
  await mk("B2", "ac_only");
  await mk("B3", "kitchen_only");
  await mk("B4", "semi_furnished");
  await mk("B5", "furnished");
  await mk("B6", null);
  await mk("B7", "unfurnished");
  const agency = await agencyOf(first);
  const got = await ids(agency, "apartment for rent mivida kitchen and ac");
  expect(got.slice(0, 3)).toEqual(["B1", expect.stringMatching(/^B[23]$/), expect.stringMatching(/^B[23]$/)]);
  expect(got.slice(3)).toHaveLength(3);
  expect(got.slice(3, 5).sort()).toEqual(["B4", "B5"]);
  expect(got[5]).toBe("B6");
  expect(got).not.toContain("B7");
});

test("a blank unit that has the extras recorded counts as an exact match", async () => {
  const x = await mk("C1", null);
  await h.query("UPDATE listings SET feature_keys = ARRAY['ac_installed'] WHERE id = $1", [x.id]);
  await mk("C2", "ac_only");
  await mk("C3", null);
  const agency = await agencyOf(x);
  const got = await ids(agency, "apartment for rent mivida with ac");
  expect(got[2]).toBe("C3");
  expect(got.slice(0, 2).sort()).toEqual(["C1", "C2"]);
});

test('"semi furnished" lists semi first, then kitchen and AC, AC only, kitchen only, then blank', async () => {
  const first = await mk("S1", "semi_furnished");
  await mk("S2", "kitchen_and_ac");
  await mk("S3", "ac_only");
  await mk("S4", "kitchen_only");
  await mk("S5", null);
  await mk("S6", "furnished");
  await mk("S7", "unfurnished");
  const agency = await agencyOf(first);
  expect(await ids(agency, "apartment for rent mivida semi furnished")).toEqual(["S1", "S2", "S3", "S4", "S5"]);
});

test('"furnished" lists furnished, then semi-furnished, then blank', async () => {
  const first = await mk("U1", "semi_furnished");
  await mk("U2", "furnished");
  await mk("U3", null);
  await mk("U4", "kitchen_and_ac");
  const agency = await agencyOf(first);
  expect(await ids(agency, "apartment for rent mivida furnished")).toEqual(["U2", "U1", "U3"]);
});

test('"fully finished" lists fully finished, then super lux, then ultra super lux, then blank; semi finished is left out', async () => {
  const first = await mk("G1", null, { finishing: "ultra_super_lux" });
  await mk("G2", null, { finishing: "super_lux" });
  await mk("G3", null, { finishing: "fully_finished" });
  await mk("G4", null);
  await mk("G5", null, { finishing: "semi_finished" });
  await h.query("UPDATE listings SET finishing = 'ultra_super_lux' WHERE code = 'G1'");
  await h.query("UPDATE listings SET finishing = 'super_lux' WHERE code = 'G2'");
  await h.query("UPDATE listings SET finishing = 'fully_finished' WHERE code = 'G3'");
  await h.query("UPDATE listings SET finishing = 'semi_finished' WHERE code = 'G5'");
  const agency = await agencyOf(first);
  expect(await ids(agency, "apartment for rent mivida fully finished")).toEqual(["G3", "G2", "G1", "G4"]);
});
