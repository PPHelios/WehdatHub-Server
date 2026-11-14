// tests/unit/chat-listing.test.js — Chat post → Excel-style cells (parser first), and AI only fills what is missing
"use strict";

const C = require("../../domain/chatListing");

const places = { index: new Map([["hyde park", "p1"]]), rows: [{ id: "p1", name_en: "Hyde Park", name_ar: null }] };

describe("parsePost", () => {
  test("reads the fields of an Egyptian listing post, the code and the poster's phone included", () => {
    const { cells, missing } = C.parsePost("شقة للبيع في Hyde Park\nكود HP-12\nمساحة 150 متر 3 غرف 2 حمام\nالدور الثالث\nالسعر 5.5 مليون\nالمقدم 1 مليون\n01012345678", places, { sender: "Ali", at: "1/1/2026 10:00" });
    expect(cells).toMatchObject({ code: "HP-12", property_type: "apartment", listing_type: "sale", compound: "Hyde Park", area_value: "150", bedrooms: "3", bathrooms: "2", floor: "3", price_value: "5.5 مليون", down_payment_value: "1 مليون", owner_phone: "01012345678" });
    expect(missing).toEqual([]);
    expect(cells.notes).toMatch(/Ali/);
  });

  test("rent, Arabic letters next to the figures, and 'm' after a price is million, not metres", () => {
    expect(C.parsePost("فيلا للايجار Hyde Park 300 م السعر 80 الف", places).cells).toMatchObject({ listing_type: "rent", property_type: "villa", area_value: "300", price_value: "80 الف" });
    expect(C.parsePost("Apartment for sale 200 sqm price 12m", places).cells).toMatchObject({ price_value: "12m", area_value: "200" });
  });

  test("a land figure is not the unit area, and a post with both sale and rent words is left undecided", () => {
    expect(C.parsePost("فيلا للبيع أرض 500 متر مساحة 300 متر السعر 20 مليون", places).cells.area_value).toBe("300");
    expect(C.parsePost("شقة للبيع او للايجار 100 متر", places).cells.listing_type).toBeUndefined();
  });

  test("what it cannot read is listed as missing; the AI answer fills only empty cells", () => {
    const r = C.parsePost("شقة 120 متر السعر 4 مليون", places);
    expect(r.missing).toEqual(expect.arrayContaining(["compound", "listing_type"]));
    const filled = C.fillFromAi(r.cells, { compound: "Hyde Park", listing_type: "sale", area_value: 999, finishing: "semi_finished" });
    expect(filled.cells).toMatchObject({ compound: "Hyde Park", listing_type: "sale", area_value: "120", finishing: "semi finished" });
    expect(filled.filled.sort()).toEqual(["compound", "finishing", "listing_type"]);
  });

  test("phone numbers are hidden in the text kept for the quality log", () => {
    expect(C.mask("اتصل 01012345678 شقة")).not.toMatch(/0101234/);
  });
});
