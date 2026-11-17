// tests/unit/read-sanity.test.js — The last check on a post reading: a value that cannot be a real unit's price, size or room count is
// dropped with its reason (empty beats wrong), and a correct reading is never touched.
"use strict";

const { suspects } = require("../../domain/read/sanity");
const C = require("../../domain/chatListing");

const why = (cells) => suspects(cells).map((x) => `${x.cell}:${x.why}`);

describe("suspects", () => {
  test("a price that is the size said again, or impossible for its type, is flagged", () => {
    expect(why({ listing_type: "sale", area_value: "354", land_area: "420", price_value: "420m" })).toEqual(["price_value:price_is_size"]);
    expect(why({ listing_type: "sale", area_value: "150", price_value: "150" })).toEqual(["price_value:price_is_size"]);
    expect(why({ listing_type: "sale", area_value: "150", price_value: "90 الف" })).toEqual(["price_value:price_low"]);
    expect(why({ listing_type: "sale", area_value: "150", price_value: "5000 مليون" })).toEqual(["price_value:price_high"]);
    expect(why({ listing_type: "sale", area_value: "500", price_value: "50 الف" })).toEqual(["price_value:price_low"]);
    expect(why({ listing_type: "sale", area_value: "5000", price_value: "3 مليون" })).toEqual(["price_value:price_per_m2"]);
    expect(why({ listing_type: "rent", area_value: "100", price_value: "100m" })).toEqual(["price_value:price_is_size"]);
  });

  test("sizes and room counts out of range are flagged", () => {
    expect(why({ area_value: "5" })).toEqual(["area_value:area_range"]);
    expect(why({ area_value: "90000" })).toEqual(["area_value:area_range"]);
    expect(why({ bedrooms: "30", bathrooms: "20", floor: "90" })).toEqual(["bedrooms:rooms_range", "bathrooms:rooms_range", "floor:floor_range"]);
  });

  test("correct readings are never flagged: a 65k rent, dollars, several prices, a villa, a plot", () => {
    expect(why({ listing_type: "rent", area_value: "154", price_value: "65k" })).toEqual([]);
    expect(why({ listing_type: "sale", area_value: "120", price_value: "$85,000" })).toEqual([]);
    expect(why({ listing_type: "rent", area_value: "160", price_value: "short 130$ / long 2700$" })).toEqual([]);
    expect(why({ listing_type: "sale", area_value: "300", land_area: "500", price_value: "25 مليون" })).toEqual([]);
    expect(why({ listing_type: "sale", area_value: "1000", price_value: "10 مليون" })).toEqual([]);
    expect(why({ area_value: "154", price_value: "65k" })).toEqual([]); // type not said: only the impossible is flagged
  });
});

describe("parsePost drops a suspect cell and says why", () => {
  test("an impossible sale price is empty, not wrong; the other cells stay", () => {
    const out = C.parsePost("شقة للبيع 150م 3 غرف السعر 90 الف");
    expect(out.cells.price_value).toBeUndefined();
    expect(out.cells.area_value).toBe("150");
    expect(out.suspect).toEqual([{ cell: "price_value", why: "price_low" }]);
    expect(out.missing).toContain("price_value");
  });
});
