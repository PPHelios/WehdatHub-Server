// tests/router/owner-confirm.test.js — Adding a unit by Telegram: a new owner's phone or a matching owner is shown on the
// card as the owner's data, with no question; saving creates or links the owner. Only a saved owner under another name
// asks which name to keep.
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
      ? { listing_type: "sale", market: "resale", property_type: "apartment", compound: "Hyde Park", area_value: 150, bedrooms: 3, price_value: 8500000, delivery: {}, features: [], features_other: [], resale: {}, primary: {} }
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

test("a new owner's phone is shown as the owner's data, with no question; saving creates and links the owner", async () => {
  const card = await reviewWithOwner("Mr New", "01012345678");
  const text = textOf(card);
  expect(text).toMatch(/Mr New/);
  expect(text).not.toMatch(/Create and link|تضيفه وتربط|New owner|مالك جديد/);
  expect(ids(card[card.length - 1])).not.toContain("draft_owner_keep");
  expect(ids(card[card.length - 1])).not.toContain("draft_owner_drop");
  expect(ids(card[card.length - 1])).toContain("draft_confirm");
  await h.tap("broker", "draft_confirm");
  const [l] = await h.query("SELECT owner_id, details FROM listings WHERE code = 'HP-77'");
  expect(l.owner_id).not.toBeNull();
  expect(l.details.owner_phone.replace(/\D/g, "")).toMatch(/1012345678$/);
  expect((await ownerRow("201012345678")).name).toBe("Mr New");
});

test("a phone of an existing owner links the unit to that owner, not a new one, with no question", async () => {
  const [owner] = await h.query(
    "INSERT INTO unit_owners (agency_id, name, phones, created_by) VALUES ($1, 'Known Owner', ARRAY['201055550000']::text[], $2) RETURNING *",
    [h.AGENCY_A, h.BROKERS.broker.id]
  );
  const card = await reviewWithOwner("Known Owner", "01055550000");
  expect(textOf(card)).not.toMatch(/Existing owner|مالك موجود|Link this unit/);
  expect(ids(card[card.length - 1])).toContain("draft_confirm");
  await h.tap("broker", "draft_confirm");
  const [l] = await h.query("SELECT owner_id FROM listings WHERE code = 'HP-77'");
  expect(l.owner_id).toBe(owner.id);
  expect((await h.query("SELECT count(*)::int AS n FROM unit_owners WHERE agency_id = $1", [h.AGENCY_A]))[0].n).toBe(1);
});

// A typed owner line ("Owner: name number") is read exactly; a saved owner with another name asks which name to keep.
test("a typed owner line with a saved owner under another name lets the broker choose the name", async () => {
  await h.query(
    "INSERT INTO unit_owners (agency_id, name, phones, created_by) VALUES ($1, 'Old Name', ARRAY['201055550011']::text[], $2)",
    [h.AGENCY_A, h.BROKERS.broker.id]
  );
  await h.text("broker", "اضافة");
  await h.text("broker", "شقة هايد بارك 150 متر 3 غرف 8.5 مليون كود HP-78");
  await h.text("broker", "Owner: New Name 01055550011");
  const card = await h.text("broker", "تم");
  expect(textOf(card)).toMatch(/Old Name/);
  expect(textOf(card)).toMatch(/New Name/);
  expect(ids(card[card.length - 1])).toContain("draft_owner_keep_typed");
  const after = await h.tap("broker", "draft_owner_keep_typed");
  expect(ids(after[after.length - 1])).toContain("draft_confirm");
  await h.tap("broker", "draft_confirm");
  const [l] = await h.query("SELECT owner_id FROM listings WHERE code = 'HP-78'");
  expect(l.owner_id).not.toBeNull();
  expect((await ownerRow("201055550011")).name).toBe("Old Name"); // a broker cannot rename: it is a request
  expect((await h.query("SELECT new_value FROM owner_change_requests WHERE status = 'pending'"))[0].new_value).toBe("New Name");
  expect((await h.query("SELECT count(*)::int AS n FROM unit_owners WHERE agency_id = $1", [h.AGENCY_A]))[0].n).toBe(1);
});
