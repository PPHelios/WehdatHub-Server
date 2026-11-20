// tests/unit/nav-segments.test.js — the menu follows the workspace (lib/navSpec.js forBroker { workspace }): solo, team, a lone non-owner,
// grandfathered features, and agency tier unchanged for every role. (The role bars with no workspace stay in nav-spec.test.js.)
"use strict";

const Nav = require("../../lib/navSpec");

const who = (role) => ({ id: "b1", role });
const ws = (tier, mode, members, keep = []) => ({ tier, mode, members, teamStyle: "shared", keep });
const SOLO = ws("solo", "solo", 1);
const TEAM = ws("team", "team", 3);
const AGENCY = ws("agency", "agency", 20);
const nav = (role, workspace) => Nav.forBroker(who(role), { workspace });
const bar = (role, workspace) => nav(role, workspace).tabs.map((t) => t.key);
const keys = (n) => n.groups.flatMap((g) => g.items.map((i) => i.key));

test("agency tier (and pilots) menus are exactly the menus with no workspace, for every role", () => {
  for (const role of ["broker", "team_lead", "manager", "admin", "owner", "data_entry"]) {
    expect(nav(role, AGENCY)).toEqual(Nav.forBroker(who(role)));
    expect(keys(nav(role, AGENCY))).not.toContain("addteammate");
  }
  expect(bar("owner", AGENCY)).toEqual(["home", "team", "dashboard", "leads", "more"]);
  expect(bar("manager", AGENCY)).toEqual(["home", "team", "leads", "search", "more"]);
  expect(bar("team_lead", AGENCY)).toEqual(["home", "team", "search", "leads", "more"]);
  expect(bar("broker", AGENCY)).toEqual(["home", "leads", "search", "units", "more"]);
  expect(bar("data_entry", AGENCY)).toEqual(["search", "units", "add", "owners", "settings"]);
});

test("solo: broker-style bar, Plan and Settings, one add-a-teammate row, no Team, Dashboard, lead rules, activity log or access requests", () => {
  const n = nav("owner", SOLO);
  expect(bar("owner", SOLO)).toEqual(["home", "leads", "search", "units", "more"]);
  expect(n.tabs[2]).toMatchObject({ key: "search", fab: true });
  const k = keys(n);
  for (const gone of ["team", "dashboard", "sources", "winloss", "access", "leadrules", "activity"]) expect(k).not.toContain(gone);
  expect(k.filter((x) => x === "addteammate")).toHaveLength(1);
  expect(k).toContain("settings");
  expect(n.groups.flatMap((g) => g.items).find((i) => i.key === "usage").label).toEqual({ ar: "باقتي", en: "My plan" });
});

test("team tier owner: Today, Leads, Search (centre), Team, More; no agency-only pages", () => {
  const n = nav("owner", TEAM);
  expect(bar("owner", TEAM)).toEqual(["home", "leads", "search", "team", "more"]);
  expect(n.tabs[2].fab).toBe(true);
  for (const gone of ["sources", "winloss", "leadrules", "addteammate"]) expect(keys(n)).not.toContain(gone);
  expect(keys(n)).toContain("team");
});

test("a lone non-owner keeps the broker menu and never gets owner pages", () => {
  const lone = ws("solo", "team", 1);
  for (const role of ["broker", "manager", "team_lead"]) {
    expect(bar(role, lone)).toEqual(["home", "leads", "search", "units", "more"]);
    expect(keys(nav(role, lone))).not.toContain("addteammate");
  }
  expect(keys(nav("broker", lone))).not.toContain("team");
});

test("a grandfathered feature stays on the menu below the agency tier", () => {
  expect(keys(nav("owner", ws("team", "team", 3, ["sources", "winLoss"])))).toEqual(expect.arrayContaining(["sources", "winloss"]));
});
