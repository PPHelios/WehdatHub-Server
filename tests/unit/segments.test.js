// tests/unit/segments.test.js — domain/segments.js (tier, mode, features) and lib/workspace.js (one memoised read, forget).
"use strict";

const Seg = require("../../domain/segments");
const Workspace = require("../../lib/workspace");
const PlanGuard = require("../../lib/planGuard");

describe("tierOf", () => {
  test("by seats; a pilot is agency", () => {
    expect(Seg.tierOf({ seats: 1 })).toBe("solo");
    expect(Seg.tierOf({ seats: 2 })).toBe("team");
    expect(Seg.tierOf({ seats: 5 })).toBe("team");
    expect(Seg.tierOf({ seats: 15 })).toBe("agency");
    expect(Seg.tierOf({ seats: 25 })).toBe("agency");
    expect(Seg.tierOf({ seats: 5 }, { pilot: true })).toBe("agency");
    expect(Seg.tierOf(null)).toBe("solo");
  });
});

describe("modeOf", () => {
  test("lone owner below agency is solo", () => {
    expect(Seg.modeOf({ tier: "solo", activeMembers: 1, role: "owner" })).toBe("solo");
    expect(Seg.modeOf({ tier: "team", activeMembers: 1, role: "owner" })).toBe("solo");
  });
  test("more than one member is never solo (downgrade keeps members)", () => {
    expect(Seg.modeOf({ tier: "solo", activeMembers: 3, role: "owner" })).toBe("team");
  });
  test("a lone non-owner keeps the broker menu (team mode)", () => {
    expect(Seg.modeOf({ tier: "solo", activeMembers: 1, role: "broker" })).toBe("team");
    expect(Seg.modeOf({ tier: "team", activeMembers: 1, role: "manager" })).toBe("team");
  });
  test("agency tier is always agency", () => {
    expect(Seg.modeOf({ tier: "agency", activeMembers: 1, role: "owner" })).toBe("agency");
  });
});

describe("allows", () => {
  const ws = (tier, members) => ({ tier, members });
  test("team features need a team tier and a second person", () => {
    expect(Seg.allows(ws("solo", 1), "assignLeads")).toBe(false);
    expect(Seg.allows(ws("team", 1), "assignLeads")).toBe(false);
    expect(Seg.allows(ws("team", 2), "assignLeads")).toBe(true);
    expect(Seg.allows(ws("solo", 3), "assignLeads")).toBe(false);
  });
  test("the team page works for a lone owner on the team tier (to invite)", () => {
    expect(Seg.allows(ws("team", 1), "teamPage")).toBe(true);
  });
  test("agency features are agency only; private units never at team level", () => {
    for (const f of ["leadRules", "teamLead", "dataEntry", "sources", "winLoss", "privateUnits"]) {
      expect(Seg.allows(ws("team", 5), f)).toBe(false);
      expect(Seg.allows(ws("agency", 20), f)).toBe(true);
    }
  });
  test("unknown feature or workspace is refused", () => {
    expect(Seg.allows(ws("agency", 20), "nope")).toBe(false);
    expect(Seg.allows(null, "teamPage")).toBe(false);
  });
});

describe("invite roles and team style", () => {
  const roles = ["broker", "manager", "data_entry", "team_lead"];
  test("below agency: broker and manager (team lead and data entry only where the plan has them)", () => {
    expect(Seg.inviteRolesFor({ tier: "team" }, roles)).toEqual(["broker", "manager"]);
    expect(Seg.inviteRolesFor({ tier: "agency" }, roles)).toEqual(roles);
  });
  test("team style defaults to shared and agency ignores it", () => {
    expect(Seg.styleFor("team", undefined)).toBe("shared");
    expect(Seg.styleFor("team", "structured")).toBe("structured");
    expect(Seg.styleFor("agency", "shared")).toBe("structured");
  });
});

describe("workspace.stateOf memo", () => {
  const plan = (seats, pilot = false) => ({ plan: { seats }, pilot });
  let calls;
  let members;
  const pool = { query: async () => (calls++, { rows: [{ team_style: "shared", analytics_enabled: true, members }] }) };
  let spy;
  beforeEach(() => {
    calls = 0;
    members = 1;
    Workspace.forgetAll();
    spy = jest.spyOn(PlanGuard, "stateOf").mockResolvedValue(plan(5));
  });
  afterEach(() => spy.mockRestore());

  test("one query per agency inside the window, role changes only the mode", async () => {
    const a = await Workspace.stateOf(pool, "ag1", { role: "owner" });
    const b = await Workspace.stateOf(pool, "ag1", { role: "broker" });
    expect(calls).toBe(1);
    expect(a).toMatchObject({ tier: "team", mode: "solo", members: 1, solo: true, teamStyle: "shared", analytics: true });
    expect(b.mode).toBe("team");
  });

  test("forget drops the memo", async () => {
    await Workspace.stateOf(pool, "ag1");
    members = 3;
    expect((await Workspace.stateOf(pool, "ag1")).members).toBe(1);
    Workspace.forget("ag1");
    const ws = await Workspace.stateOf(pool, "ag1");
    expect(ws.members).toBe(3);
    expect(ws.mode).toBe("team");
    expect(calls).toBe(2);
  });

  test("falls back when the team_style column is missing", async () => {
    let n = 0;
    const old = { query: async () => (n++ === 0 ? Promise.reject(Object.assign(new Error("x"), { code: "42703" })) : { rows: [{ analytics_enabled: false, members: 2 }] }) };
    const ws = await Workspace.stateOf(old, "ag2");
    expect(ws).toMatchObject({ teamStyle: "shared", members: 2 });
  });

  test("no agency id is a lone solo workspace", async () => {
    expect(await Workspace.stateOf(pool, null)).toMatchObject({ tier: "solo", mode: "solo" });
    expect(calls).toBe(0);
  });
});
