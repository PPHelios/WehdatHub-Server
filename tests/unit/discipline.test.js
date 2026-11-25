// tests/unit/discipline.test.js — Pure broker app-update discipline classification and agency summary.
"use strict";

const Discipline = require("../../domain/discipline");

describe("domain/discipline", () => {
  test("classifies silent, lagging, and consistent brokers cleanly", () => {
    expect(Discipline.classifyBroker({ active: true, open: 3, updates48h: 0, staleOpen: 0, noNextStep: 0, missed: 0, responded: 2 })).toBe("silent");
    expect(Discipline.classifyBroker({ active: true, open: 2, updates48h: 0, staleOpen: 0, noNextStep: 0, missed: 0, responded: 0 })).toBe("consistent");
    expect(Discipline.classifyBroker({ active: true, open: 4, updates48h: 1, staleOpen: 1, noNextStep: 0, missed: 0, responded: 2 })).toBe("lagging");
    expect(Discipline.classifyBroker({ active: true, open: 4, updates48h: 1, staleOpen: 0, noNextStep: 3, missed: 0, responded: 2 })).toBe("lagging");
    expect(Discipline.classifyBroker({ active: true, open: 4, updates48h: 1, staleOpen: 0, noNextStep: 0, missed: 3, responded: 2 })).toBe("lagging");
    expect(Discipline.classifyBroker({ active: false, open: 5, updates48h: 0, staleOpen: 2, noNextStep: 3, missed: 1, responded: 0 })).toBe("consistent");
  });

  test("summarizeBoard totals active broker discipline statuses and counts", () => {
    const summary = Discipline.summarizeBoard([
      { active: true, discipline: "consistent", noNextStep: 1, missed: 0 },
      { active: true, discipline: "lagging", noNextStep: 3, missed: 2 },
      { active: true, discipline: "silent", noNextStep: 2, missed: 1 },
      { active: false, discipline: "silent", noNextStep: 9, missed: 9 }
    ]);
    expect(summary).toEqual({
      consistent: 1,
      lagging: 1,
      silent: 1,
      totalNoNextStep: 6,
      totalMissed: 3
    });
  });
});
