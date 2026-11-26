// tests/unit/urgency.test.js — Role-dynamic SearchHome priority ranking (domain/urgency.js).
"use strict";

const Urgency = require("../../domain/urgency");

describe("domain/urgency.buildPriorities", () => {
  test("omits zero-count items and ranks manager priorities by urgency", () => {
    const out = Urgency.buildPriorities({
      role: "owner",
      ops: { unassigned: 2, uncontactedOld: 1, overdue: 4 },
      waitingOver1h: 3,
      calls: 5,
      tomorrowViewings: 0,
      intake: { disconnected: 1, failed: 2 },
      approvals: { access: 1, names: 1 },
      commissions: { overdue: 2, registrations: 0 },
      leasesSoon: 1,
      missingPhotos: 6,
      nextViewing: { ref: "L-10", name: "Mona", at: "2026-11-25T15:00:00Z" }
    });
    expect(out.map((p) => p.id)).toEqual([
      "unassigned",
      "waiting-over-1h",
      "overdue",
      "intake",
      "approvals",
      "owner-names",
      "commissions",
      "next-viewing",
      "calls",
      "leases-soon",
      "missing-photos"
    ]);
    expect(out.find((p) => p.id === "waiting-over-1h").extra).toEqual({ over24h: 1 });
    expect(out.find((p) => p.id === "intake")).toMatchObject({ count: 3, urgency: "high", action: { kind: "screen", screen: "Sources" } });
    expect(out.find((p) => p.id === "approvals")).toMatchObject({ count: 1, action: { kind: "screen", screen: "Requests" } });
    expect(out.find((p) => p.id === "owner-names")).toMatchObject({ count: 1, action: { kind: "screen", screen: "Owners" } });
  });

  test("broker & team_lead deduplicate waiting-over-1h against new-leads", () => {
    const exact = Urgency.buildPriorities({ role: "broker", overdue: 1, waitingOver1h: 2, newLeads: 2, calls: 0, missingPhotos: 1 });
    expect(exact.map((p) => p.id)).toEqual(["overdue", "waiting-over-1h", "missing-photos"]);

    const withFresh = Urgency.buildPriorities({ role: "team_lead", waitingOver1h: 2, newLeads: 5 });
    expect(withFresh.map((p) => [p.id, p.count])).toEqual([
      ["waiting-over-1h", 2],
      ["new-leads", 3]
    ]);
  });

  test("data_entry prioritizes overdue units and missing photos only", () => {
    const out = Urgency.buildPriorities({ role: "data_entry", overdueUnitsTotal: 4, missingPhotos: 2, overdue: 99 });
    expect(out.map((p) => p.id)).toEqual(["overdue-units", "missing-photos"]);
  });
});
