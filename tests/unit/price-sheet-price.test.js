"use strict";

// A price cell that reads no number ("wait", "under finishing") is an error on its row, never a price: the text
// must not reach listing_prices (its check is price > 0).
const { rowToEntry } = require("../../domain/priceSheet");

describe("price sheet price cell", () => {
  test("a cell with no number is held as a missing price, not stored as text", () => {
    for (const price of ["wait", "under finishing", "sold"]) {
      const e = rowToEntry({ property_type: "apartment", area: "120", price });
      expect(e.error).toBe("price");
      expect(e.price).toBeUndefined();
    }
  });

  test("a cell with several prices takes the monthly or long-term one; dollars are held", () => {
    expect(rowToEntry({ property_type: "apartment", area: "120", price: "long 90k / short 100k / day 6k" }).price).toBe(90000);
    expect(rowToEntry({ property_type: "apartment", area: "120", price: "1800$" }).error).toBe("price");
  });
});
