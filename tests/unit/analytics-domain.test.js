// tests/unit/analytics-domain.test.js — The pure market-analytics rules: privacy thresholds and suppression, fixed bands,
// the search cell, market cells and the funnel (no database).
"use strict";

const Privacy = require("../../domain/analyticsPrivacy");
const Bands = require("../../domain/analyticsBands");
const Market = require("../../domain/analyticsMarket");
const Funnel = require("../../domain/analyticsFunnel");

describe("privacy thresholds", () => {
  test("the k thresholds are 5 agencies and 10 rows", () => {
    expect(Privacy.MIN_AGENCIES).toBe(5);
    expect(Privacy.MIN_ROWS).toBe(10);
  });

  test("a cell passes only with enough agencies AND enough rows", () => {
    expect(Privacy.passes({ agencies_n: 5, rows_n: 10 })).toBe(true);
    expect(Privacy.passes({ agencies_n: 4, rows_n: 500 })).toBe(false);
    expect(Privacy.passes({ agencies_n: 50, rows_n: 9 })).toBe(false);
    expect(Privacy.suppress({ agencies_n: 4, rows_n: 10 })).toBeNull();
    expect(Privacy.suppress({ agencies_n: 5, rows_n: 10 })).toEqual({ agencies_n: 5, rows_n: 10 });
    expect(Privacy.keepPassing([{ agencies_n: 5, rows_n: 12 }, { agencies_n: 1, rows_n: 1 }])).toHaveLength(1);
  });

  test("assertClean refuses forbidden fields and phone-like values, and allows ids and dates", () => {
    expect(() => Privacy.assertClean({ phone_e164: "+201001234567" })).toThrow(/analytics privacy/);
    expect(() => Privacy.assertClean({ rows: [{ client_name: "x" }] })).toThrow();
    expect(() => Privacy.assertClean({ text: "call 01001234567" })).toThrow();
    expect(() => Privacy.assertClean({ text: "+20 100 123 4567" })).toThrow();
    expect(() => Privacy.assertClean({ id: "a0000000-0000-0000-0000-0000000000c1", day: "2026-11-19", month: "2026-11", n: 12345678901 })).not.toThrow();
  });
});

describe("bands", () => {
  test("bedroom bands are 0,1,2,3,4 and 5+", () => {
    expect(["0", 1, 2, 3, 4, 5, 9].map(Bands.bedroomBand)).toEqual(["0", "1", "2", "3", "4", "5+", "5+"]);
    expect(Bands.bedroomBand(null)).toBeNull();
    expect(Bands.bedroomBand(-1)).toBeNull();
  });

  test("budget bands are fixed EGP ranges per sale or rent", () => {
    expect(Bands.budgetBands("sale")).toEqual(["<1M", "1M-2M", "2M-3M", "3M-5M", "5M-8M", "8M-15M", "15M+"]);
    expect(Bands.budgetBand("sale", 900000)).toBe("<1M");
    expect(Bands.budgetBand("sale", 1000000)).toBe("1M-2M");
    expect(Bands.budgetBand("sale", 99e6)).toBe("15M+");
    expect(Bands.budgetBand("rent", 25000)).toBe("20k-40k");
    expect(Bands.budgetBand("rent", null)).toBe("any");
    expect(Bands.budgetBand(null, 5e6)).toBe("any");
  });

  test("a search cell reads filters only and never the words", () => {
    const cell = Bands.searchCell({ listing_type: "sale", property_types: ["apartment"], bedrooms_min: 3, bedrooms_max: 3, price_max: 4500000, area_scope: { areas: ["a0000000-0000-0000-0000-0000000000c1"] }, query_text: "my name is Ahmed 01001234567" });
    expect(cell).toEqual({ area_id: "a0000000-0000-0000-0000-0000000000c1", area_key: null, property_type: "apartment", listing_type: "sale", bedroom_band: "3", budget_band: "3M-5M" });
    expect(JSON.stringify(cell)).not.toMatch(/Ahmed|0100/);
    expect(Bands.searchCell(null)).toMatchObject({ property_type: "any", listing_type: "any", bedroom_band: "any", budget_band: "any" });
    expect(Bands.searchCell({ listing_type: "sale", currency: "USD", price_max: 100000 }).budget_band).toBe("any");
  });

  test("sources and lost reasons become fixed keys, never the typed text", () => {
    expect(Bands.sourceKey("facebook")).toBe("Facebook");
    expect(Bands.sourceKey("فيسبوك")).toBe("Facebook");
    expect(Bands.sourceKey("Ahmed's cousin 01001234567")).toBe("Other");
    expect(Bands.sourceKey("")).toBe("Unknown");
    expect(Bands.lostKey("غالي أوي ومعاه رقم 01001234567")).toBe("price");
    expect(Bands.lostKey("something personal about Mona")).toBe("other");
  });

  test("percentile and median", () => {
    expect(Bands.median([1, 2, 3, 4])).toBe(2.5);
    expect(Bands.percentile([10, 20, 30, 40, 50], 0.25)).toBe(20);
    expect(Bands.median([])).toBeNull();
  });
});

const unit = (agency, over = {}) => ({ agency_id: agency, area_id: "area-c", parent_id: "area-p", property_type: "apartment", listing_type: "sale", bedroom_band: "3", price: 1500000, area_m2: 100, active: true, is_new: false, removed: false, sold: false, days_to_close: null, ask_gap_pct: null, ...over });
const many = (agencies, per, over) => agencies.flatMap((a) => Array.from({ length: per }, () => unit(a, over)));

describe("market cells", () => {
  test("a cell with 4 agencies is not written as detail, even with many rows", () => {
    const cells = Market.computeCells(many(["a1", "a2", "a3", "a4"], 10), "2026-11-18");
    expect(cells).toEqual([]);
  });

  test("a cell with 5 agencies and 10 rows is written with percentiles", () => {
    const cells = Market.computeCells(many(["a1", "a2", "a3", "a4", "a5"], 2), "2026-11-18");
    const fine = cells.find((c) => c.area_id === "area-c" && c.bedroom_band === "3");
    expect(fine).toMatchObject({ agencies_n: 5, rows_n: 10, listings_active: 10, price_m2_p50: 15000, price_p50: 1500000 });
    expect(cells.some((c) => c.area_id === "area-p" && c.bedroom_band === "all")).toBe(true);
    expect(cells.some((c) => c.area_id === null && c.property_type === "all")).toBe(true);
  });

  test("a small area rolls up: its units count in the parent and everywhere, but no row exists for the small area", () => {
    const rows = [...many(["a1", "a2", "a3", "a4", "a5"], 2, { area_id: "area-big", parent_id: "area-p" }), unit("a1", { area_id: "area-tiny", parent_id: "area-p" }), unit("a2", { area_id: "area-tiny", parent_id: "area-p" })];
    const cells = Market.computeCells(rows, "2026-11-18");
    expect(cells.some((c) => c.area_id === "area-tiny")).toBe(false);
    const parent = cells.find((c) => c.area_id === "area-p" && c.property_type === "apartment" && c.listing_type === "sale");
    expect(parent.rows_n).toBe(12);
  });

  test("percentile columns are dropped when too few priced units stand behind them, days to close needs 5 closed units", () => {
    const rows = many(["a1", "a2", "a3", "a4", "a5"], 2, { price: null });
    expect(Market.computeCells(rows, "d").every((c) => c.price_m2_p50 === null)).toBe(true);
    const sold = many(["a1", "a2", "a3", "a4", "a5"], 2, { active: false, sold: true, removed: true, days_to_close: 30, ask_gap_pct: -4 });
    const cell = Market.computeCells(sold, "d").find((c) => c.area_id === "area-c" && c.bedroom_band === "3");
    expect(cell).toMatchObject({ sold_count: 10, median_days_to_close: 30, asking_vs_closed_pct: -4, removed_listings: 10 });
    const few = Market.computeCells([...sold.slice(0, 1), ...many(["a1", "a2", "a3", "a4", "a5"], 2)], "d").find((c) => c.area_id === "area-c" && c.bedroom_band === "3");
    expect(few.median_days_to_close).toBeNull();
  });

  test("no cell carries a personal field", () => {
    const cells = Market.computeCells(many(["a1", "a2", "a3", "a4", "a5"], 2), "2026-11-18");
    expect(() => Privacy.assertClean(cells)).not.toThrow();
    for (const c of cells) expect(Object.keys(c).sort()).toEqual(["agencies_n", "area_id", "asking_vs_closed_pct", "bedroom_band", "day", "listing_type", "listings_active", "median_days_to_close", "new_listings", "price_m2_p25", "price_m2_p50", "price_m2_p75", "price_p50", "property_type", "removed_listings", "rows_n", "sold_count"]);
  });
});

describe("funnel", () => {
  const lead = (agency, over = {}) => ({ agency_id: agency, contacted: true, viewed: false, lost: false, source: "Facebook", lost_reason: null, response_min: 10, ...over });
  const leadsOf = (agency, n, over) => Array.from({ length: n }, () => lead(agency, over));

  test("an agency row counts its own leads, rates, sources and bucketed lost reasons", () => {
    const rows = Funnel.agencyRows([...leadsOf("a1", 3), lead("a1", { contacted: false, lost: true, lost_reason: "غالي", source: "Mona 01001234567" })], { a1: 2 }, "2026-11-01");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agency_id: "a1", leads: 4, contacted: 3, deals: 2, lost: 1, median_first_response_minutes: 10 });
    expect(rows[0].by_source).toEqual({ Facebook: 3, Other: 1 });
    expect(rows[0].lost_reasons).toEqual({ price: 1 });
    expect(rows[0].rates.contacted_pct).toBe(75);
    expect(() => Privacy.assertClean(rows)).not.toThrow();
  });

  test("the market row needs 5 agencies with 3+ leads and 10+ leads; fewer gives no market row", () => {
    const five = ["a1", "a2", "a3", "a4", "a5"].flatMap((a) => leadsOf(a, 4));
    const mk = Funnel.marketRow(Funnel.agencyRows(five, {}, "2026-11-01"), "2026-11-01");
    expect(mk).toMatchObject({ agency_id: null, agencies_n: 5, leads: 4 });
    const four = ["a1", "a2", "a3", "a4"].flatMap((a) => leadsOf(a, 40));
    expect(Funnel.marketRow(Funnel.agencyRows(four, {}, "2026-11-01"), "2026-11-01")).toBeNull();
    const tiny = ["a1", "a2", "a3", "a4", "a5"].flatMap((a) => leadsOf(a, 2));
    expect(Funnel.marketRow(Funnel.agencyRows(tiny, {}, "2026-11-01"), "2026-11-01")).toBeNull();
  });
});
