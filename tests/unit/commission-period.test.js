// tests/unit/commission-period.test.js — The commissions tab's period filter follows the Cairo calendar: a month runs
// from its 1st to the next 1st, a week from Monday to Monday, and "all" has no bounds.
"use strict";

const { periodRange } = require("../../domain/commissionPeriod");

describe("periodRange", () => {
  test("month: the 1st to the next 1st, Cairo midnights (UTC+2 in November)", () => {
    const r = periodRange("month", "2026-11-15");
    expect(r).toMatchObject({ period: "month", fromDay: "2026-11-01", toDay: "2026-11-30", prevAt: "2026-10-01", nextAt: "2026-12-01" });
    expect(r.from).toBe("2026-10-31T22:00:00.000Z");
    expect(r.to).toBe("2026-11-30T22:00:00.000Z");
  });

  test("week: Monday to Monday, whatever day the anchor is", () => {
    expect(periodRange("week", "2026-11-05")).toMatchObject({ fromDay: "2026-11-02", toDay: "2026-11-08", prevAt: "2026-10-29", nextAt: "2026-11-12" });
    expect(periodRange("week", "2026-11-08")).toMatchObject({ fromDay: "2026-11-02", toDay: "2026-11-08" });
    expect(periodRange("week", "2026-11-09")).toMatchObject({ fromDay: "2026-11-09", toDay: "2026-11-15" });
  });

  test("all: no bounds; unknown periods fall back to the month; a bad day falls back to today", () => {
    expect(periodRange("all", "2026-11-05")).toMatchObject({ period: "all", from: null, to: null, prevAt: null });
    expect(periodRange("bogus", "2026-11-05").period).toBe("month");
    expect(periodRange("month", "not-a-day", new Date("2026-11-05T12:00:00Z")).at).toBe("2026-11-05");
  });
});
