// tests/web/side-menu.test.js — the side menu and the More page are drawn from lib/navSpec.js: collapsible groups
// (details/summary, Clients and Listings open by default, the group of the current page open), the same groups on /app/more,
// no repeated bar items on More, and the grouped labels match the spec per role.
"use strict";

const Html = require("../../web/html");

const who = (role) => ({ id: "b1", role, agency_id: "a" });
const side = (role, tab = "home", lang = "en") => String(Html.sideMenu(who(role), tab, lang));
const groupsIn = (html) => [...html.matchAll(/<details class="side-group" data-group="([a-z]+)"( open)?>/g)].map((m) => [m[1], Boolean(m[2])]);

test("the groups are <details> in spec order; Clients and Listings start open, the others closed", () => {
  expect(groupsIn(side("manager"))).toEqual([
    ["clients", true],
    ["listings", true],
    ["find", false],
    ["agency", false],
    ["account", false]
  ]);
  expect(groupsIn(side("broker")).map((g) => g[0])).toEqual(["clients", "listings", "find", "account"]);
});

test("each group summary says whether it is open, and works with no script", () => {
  const html = side("manager");
  expect(html).toMatch(/<summary aria-expanded="true">Clients<\/summary>/);
  expect(html).toMatch(/<summary aria-expanded="false">Agency<\/summary>/);
  expect(html).not.toMatch(/<script/);
});

test("the group holding the current page starts open", () => {
  expect(groupsIn(side("manager", "team")).find((g) => g[0] === "agency")).toEqual(["agency", true]);
  expect(groupsIn(side("manager", "home")).find((g) => g[0] === "agency")).toEqual(["agency", false]);
});

test("the current page is marked in its group", () => {
  expect(side("broker", "leads")).toMatch(/<a href="\/app\/leads" aria-current="page">/);
});

test("Arabic labels come from the same spec", () => {
  const html = side("manager", "home", "ar");
  expect(html).toContain("العملاء");
  expect(html).toContain("الشركة");
  expect(html).toContain("حسابي");
});

test("data entry: Search, Units and Owners in their groups, no leads or agency pages", () => {
  const html = side("data_entry");
  for (const k of ["/app/units", "/app/owners", "/app/search", "/app/settings", "/app/notifications", "/app/guide", "/app/import"]) expect(html).toContain(`href="${k}"`);
  for (const k of ["/app/leads", "/app/deals", "/app/dashboard", "/app/team", "/app/usage", "/app/plan"]) expect(html).not.toContain(`href="${k}"`);
  expect(groupsIn(html).map((g) => g[0])).toEqual(["clients", "listings", "find", "account"]);
});

test("the More list groups leave out what is on the bottom bar and what the website has no page for", () => {
  const broker = Html.moreGroups(who("broker"));
  const keys = broker.flatMap((g) => g.items.map((i) => i.key));
  expect(keys).not.toContain("leads"); // on the bar
  expect(keys).not.toContain("units"); // on the bar for a broker
  expect(keys).not.toContain("leases"); // an app screen only
  expect(keys).toContain("map");
  const manager = Html.moreGroups(who("manager")).flatMap((g) => g.items.map((i) => i.key));
  expect(manager).toContain("units"); // a manager has Team on the bar, Units in the menu
  expect(manager).not.toContain("team");
  expect(Html.moreGroups(who("broker")).map((g) => g.key)).toEqual(["clients", "listings", "find", "account"]);
});

test("the bottom bar comes from the spec", () => {
  expect(Html.tabsFor(who("broker")).map((t) => t.key)).toEqual(["home", "search", "add", "leads", "units"]);
  expect(Html.tabsFor(who("team_lead")).map((t) => t.key)).toEqual(["home", "search", "add", "leads", "team"]);
  expect(Html.tabsFor(who("data_entry")).map((t) => t.key)).toEqual(["search", "units", "add", "owners", "settings"]);
});
