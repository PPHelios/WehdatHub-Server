// tests/router/compound-pick.test.js — Adding a unit by Telegram: a compound that is not on the approved list asks which
// one it is (close names as buttons, or add as new) before the unit can be confirmed.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness, textOf } = require("../harness/app");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  h.AI.respond((c) =>
    c.operation === "listing_extraction"
      ? { listing_type: "sale", market: "resale", property_type: "apartment", compound: "Hyde Park Estate", area_value: 150, bedrooms: 3, price_value: 8500000, delivery: {}, features: [], features_other: [], resale: {}, primary: {} }
      : null
  );
});
afterAll(closeHarness);

const contact = (who, name, phone) =>
  h.send(who, { type: "contacts", contacts: [{ name: { formatted_name: name }, phones: [{ phone, type: "CELL" }] }] });
const ids = (r) => (r.buttons || []).map((b) => b.id);
const ownerRow = async (phone) => (await h.query("SELECT * FROM unit_owners WHERE phones @> ARRAY[$1]::text[]", [phone]))[0];

// Opens a unit draft with the owner from a contact, then asks for the review card.
async function reviewWithOwner(name, phone) {
  await h.text("broker", "اضافة");
  await contact("broker", name, phone);
  await h.text("broker", "شقة هايد بارك 150 متر 3 غرف 8.5 مليون كود HP-77");
  return h.text("broker", "تم");
}


test("a misspelled compound shows close names as buttons; picking one fixes it, 'add as new' keeps it flagged", async () => {
  const card = await reviewWithOwner("Mr New", "01012345678");
  const last = card[card.length - 1];
  const pick = ids(last).find((id) => id.startsWith("draft_comp:"));
  expect(pick).toBeTruthy();
  expect(ids(last)).toContain("draft_comp_new");
  expect(ids(last)).not.toContain("draft_confirm");
  const after = await h.tap("broker", pick);
  expect(ids(after[after.length - 1])).toContain("draft_confirm");
  await h.tap("broker", "draft_confirm");
  const [l] = await h.query("SELECT compound, place_id, compound_state FROM listings WHERE code = 'HP-77'");
  expect(l.compound).toBe("هايد بارك");
  expect(l.place_id).not.toBeNull();
  expect(l.compound_state).toBeNull();
});

test("'add as new' saves the unit flagged for the CRM owner", async () => {
  const card = await reviewWithOwner("Mr New", "01012345678");
  const after = await h.tap("broker", "draft_comp_new");
  expect(ids(after[after.length - 1])).toContain("draft_confirm");
  await h.tap("broker", "draft_confirm");
  const [l] = await h.query("SELECT compound, place_id, compound_state FROM listings WHERE code = 'HP-77'");
  expect(l.compound_state).toBe("needs_fix");
  expect(l.place_id).toBeNull();
});
