// tests/unit/nav-spec.test.js — lib/navSpec.js: each role's bar and menu groups (spec-server.md sections 1 and 2),
// and every icon the menu names exists on the website (the app checks the same list on its side).
"use strict";

const Nav = require("../../lib/navSpec");
const { PATHS } = require("../../web/icons");

const who = (role, extra = {}) => ({ id: "b1", role, ...extra });
const barOf = (role, rights) => Nav.forBroker(who(role), { rights }).tabs.map((t) => t.key);
const itemsOf = (role, rights) => Nav.forBroker(who(role), { rights }).groups.flatMap((g) => g.items.map((i) => i.key));
const groupsOf = (role) => Nav.forBroker(who(role)).groups.map((g) => g.key);

test("the bar per role matches the parity table", () => {
  expect(barOf("broker")).toEqual(["home", "leads", "search", "units", "more"]);
  expect(barOf("team_lead")).toEqual(["home", "team", "search", "leads", "more"]);
  expect(barOf("manager")).toEqual(["home", "team", "leads", "search", "more"]);
  expect(barOf("admin")).toEqual(["home", "team", "leads", "search", "more"]);
  expect(barOf("owner")).toEqual(["home", "team", "dashboard", "leads", "more"]);
  expect(barOf("data_entry")).toEqual(["search", "units", "add", "owners", "settings"]);
});

test("the centre button is the role's main shortcut, and only data entry has Add on the bar", () => {
  const centre = { broker: "search", team_lead: "search", manager: "leads", admin: "leads", owner: "dashboard", data_entry: "add" };
  for (const [role, key] of Object.entries(centre)) {
    const tabs = Nav.forBroker(who(role)).tabs;
    expect(tabs).toHaveLength(5);
    expect(tabs[2]).toMatchObject({ key, fab: true });
    expect(tabs.filter((t) => t.fab)).toHaveLength(1);
  }
  for (const role of ["broker", "team_lead", "manager", "owner"]) {
    expect(Nav.forBroker(who(role)).groups[0].items[0]).toMatchObject({ key: "add", web: "/app/add", onBar: false });
  }
  expect(itemsOf("data_entry")).not.toContain("add");
});

test("groups come in the spec order and a group with no items for the role is left out", () => {
  expect(groupsOf("broker")).toEqual(["clients", "listings", "find", "account"]);
  expect(groupsOf("team_lead")).toEqual(["clients", "listings", "find", "agency", "account"]);
  expect(groupsOf("manager")).toEqual(["clients", "listings", "find", "agency", "account"]);
  expect(groupsOf("owner")).toEqual(["clients", "listings", "find", "agency", "account"]);
  expect(groupsOf("data_entry")).toEqual(["clients", "listings", "find", "account"]);
});

test("data entry: no Leases, Projects, Inbox, Leads or agency pages; menu is notifications, settings, guide plus its unit work", () => {
  const items = itemsOf("data_entry");
  for (const k of ["leases", "projects", "inbox", "leads", "deals", "dashboard", "team", "usage", "plan"]) expect(items).not.toContain(k);
  for (const k of ["notifications", "settings", "guide", "units", "search", "owners", "import", "waimport", "insights"]) expect(items).toContain(k); // Price per m² is open to every role (Haytham, 2026-11-16)
  const account = Nav.forBroker(who("data_entry")).groups.find((g) => g.key === "account").items.map((i) => i.key);
  expect(account).toEqual(["settings", "notifications", "guide"]);
});

test("data entry sees Owners only while the agency allows it", () => {
  expect(barOf("data_entry", { owners: false })).toEqual(["search", "units", "add", "settings"]);
  expect(itemsOf("data_entry", { owners: false })).not.toContain("owners");
  expect(barOf("data_entry", { owners: true })).toContain("owners");
});

test("brokers, team leads, managers and the owner all get Leases, Projects and Inbox (app screens)", () => {
  for (const role of ["broker", "team_lead", "manager", "owner"]) for (const k of ["leases", "projects", "inbox"]) expect(itemsOf(role)).toContain(k);
});

test("Plan and Invite have no menu row: the plan lives on the Usage page (managers reach payments and the invite code from there)", () => {
  for (const role of ["broker", "team_lead", "manager", "owner"]) {
    expect(itemsOf(role)).toContain("usage");
    for (const k of ["plan", "invite"]) expect(itemsOf(role)).not.toContain(k);
  }
});

test("agency pages are for managers and the owner; a team lead gets Team only; usage is for every work role", () => {
  for (const role of ["manager", "owner"]) for (const k of ["dashboard", "sources", "winloss", "access", "team"]) expect(itemsOf(role)).toContain(k);
  expect(itemsOf("team_lead")).toContain("team");
  for (const k of ["dashboard", "sources", "winloss", "access"]) expect(itemsOf("team_lead")).not.toContain(k);
  for (const k of ["dashboard", "sources", "winloss", "access", "team"]) expect(itemsOf("broker")).not.toContain(k);
  for (const role of ["broker", "team_lead", "manager", "owner"]) expect(itemsOf(role)).toContain("usage");
});

test("the product owner (crm) has the tracking pages and its own account items only", () => {
  const crm = Nav.forBroker(who("broker"), {}); // a plain broker for contrast
  expect(crm.groups.some((g) => g.key === "platform")).toBe(false);
  const cfg = require("../../config");
  const spy = jest.spyOn(require("../../lib/authz"), "isCrmOwner").mockReturnValue(true);
  try {
    const nav = Nav.forBroker(who("owner"));
    expect(nav.role).toBe("crm");
    expect(nav.tabs.map((t) => t.key)).toEqual(["home", "owner", "board", "alerts", "settings"]);
    expect(nav.tabs[2]).toMatchObject({ key: "board", fab: true });
    expect(nav.groups.map((g) => g.key)).toEqual(["account", "platform"]);
    expect(nav.groups.find((g) => g.key === "platform").items.map((i) => i.key)).toEqual(["owner", "ownermap", "ownerqueue", "ownerlibrary", "searchreview"]);
  } finally {
    spy.mockRestore();
  }
  expect(typeof cfg.getConfig).toBe("function");
});

test("items on the bar are flagged so More can leave them out", () => {
  const nav = Nav.forBroker(who("broker"));
  const flat = nav.groups.flatMap((g) => g.items);
  expect(flat.find((i) => i.key === "leads").onBar).toBe(true);
  expect(flat.find((i) => i.key === "units").onBar).toBe(true);
  expect(flat.find((i) => i.key === "map").onBar).toBe(false);
});

test("every item has Arabic and English text, one group, a web path or an app screen, and a unique key", () => {
  const keys = new Set();
  for (const i of Nav.ITEMS) {
    expect(keys.has(i.key)).toBe(false);
    keys.add(i.key);
    expect(i.label.ar).toBeTruthy();
    expect(i.label.en).toBeTruthy();
    expect(Nav.GROUPS.map((g) => g.key)).toContain(i.group);
    expect(Boolean(i.web || i.app)).toBe(true);
    for (const r of i.roles) expect(Nav.ROLES).toContain(r);
  }
});

test("every icon the menu names exists on the website", () => {
  const missing = Nav.iconNames().filter((n) => !PATHS[n]);
  expect(missing).toEqual([]);
});

test("the roles are told apart: admin and manager are managers, an unknown role is a broker", () => {
  expect(Nav.roleOf(who("admin"))).toBe("manager");
  expect(Nav.roleOf(who("Manager"))).toBe("manager");
  expect(Nav.roleOf(who("team_lead"))).toBe("team_lead");
  expect(Nav.roleOf(who("whatever"))).toBe("broker");
  expect(Nav.roleOf(null)).toBe("broker");
});
