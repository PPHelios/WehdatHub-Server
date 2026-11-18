"use strict";
const Imports = require("../../services/imports");
const FormChecks = require("../../lib/formChecks");
const ChatListing = require("../../domain/chatListing");

const before = { property_type: "apartment", listing_type: "sale", finishing: "semi_finished", price_value: 1000000 };
const patch = { property_type: "duplex", listing_type: "rent", finishing: "fully_finished" };

describe("change descriptions are localized", () => {
  test("web describeChanges shows enum values in Arabic and English", () => {
    const ar = Object.fromEntries(Imports.describeChanges(before, patch, "ar").map((c) => [c.field, c]));
    expect(ar.property_type).toMatchObject({ from: "شقة", to: "دوبلكس" });
    expect(ar.listing_type).toMatchObject({ from: "بيع", to: "إيجار" });
    expect(ar.finishing).toMatchObject({ from: "نصف تشطيب", to: "تشطيب كامل" });
    const en = Object.fromEntries(Imports.describeChanges(before, patch, "en").map((c) => [c.field, c]));
    expect(en.property_type).toMatchObject({ from: "Apartment", to: "Duplex" });
    expect(en.listing_type).toMatchObject({ from: "Sale", to: "Rent" });
  });

  test("app review changesOf carries both languages and the asked one", () => {
    const [c] = FormChecks.changesOf(before, { ...before, property_type: "duplex" }, "ar");
    expect(c).toMatchObject({ field: "property_type", from: "شقة", to: "دوبلكس", from_en: "Apartment", to_en: "Duplex" });
    expect(FormChecks.changesOf(before, { ...before, property_type: "duplex" }, "en")[0]).toMatchObject({ from: "Apartment", to: "Duplex" });
  });
});

describe("owner phone comes only from the post text", () => {
  test("no phone in the post: no owner phone, even with a phone sender", () => {
    const r = ChatListing.parsePost("شقة للبيع في التجمع 150 متر السعر 5 مليون", null, { sender: "+20 101 234 5622" });
    expect(r.cells.owner_phone).toBeUndefined();
  });
  test("digits inside a longer number are not a phone", () => {
    const r = ChatListing.parsePost("كود 1012345622999 شقة للبيع", null, {});
    expect(r.cells.owner_phone).toBeUndefined();
  });
  test("a phone in the text is read", () => {
    expect(ChatListing.parsePost("شقة للبيع 01012345622", null, {}).cells.owner_phone).toBe("01012345622");
  });
});
