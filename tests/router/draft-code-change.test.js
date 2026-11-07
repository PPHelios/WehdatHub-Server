// tests/router/draft-code-change.test.js — Before saving, the broker can change the unit code on the review card:
// a code typed into the open draft replaces the one the card shows, and Confirm saves under the new code.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");

jest.setTimeout(30000);
let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const extraction = (over = {}) => ({
  code: null, listing_type: "sale", market: "resale", property_type: "apartment", compound: "ميفيدا", compound_en: "Mivida",
  area_value: 200, bedrooms: 3, bathrooms: null, price_value: 10000000,
  delivery: { ready: null, year: null, quarter: null, month: null, raw: null }, features: [], features_other: [], resale: {}, primary: {}, ...over
});
const answerExtraction = (fields) => h.AI.respond((call) => (call.operation === "listing_extraction" ? fields : { intent: "search", filters: {}, locations: [], location_terms: [] }));
const ownerContact = () => h.send("broker", { type: "contacts", contacts: [{ name: { formatted_name: "Mr Owner" }, phones: [{ phone: "01012345678", type: "CELL" }] }] });
const listings = () => h.query("SELECT * FROM listings ORDER BY created_at");

test("a code typed into the open draft replaces the card's code, and Confirm saves under the new one", async () => {
  await h.text("broker", "اضافة");
  await ownerContact();
  await h.text("broker", "كود NH-V12 شقة في ميفيدا 200 متر 3 غرف 10 مليون");
  answerExtraction(extraction());
  await h.text("broker", "تم");
  await h.tap("broker", "draft_owner_keep");
  await h.tap("broker", "draft_owner_keep");
  // The broker changes the code while the draft is still open.
  await h.text("broker", "كود NH-V13");
  answerExtraction(extraction({ code: "NH-V13" }));
  await h.text("broker", "تم");
  await h.tap("broker", "draft_owner_keep");
  await h.tap("broker", "draft_owner_keep");
  await h.tap("broker", "draft_confirm");
  const rows = await listings();
  expect(rows.map((r) => r.code)).toEqual(["NH-V13"]);
});
