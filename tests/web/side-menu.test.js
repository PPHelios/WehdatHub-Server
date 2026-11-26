"use strict";

const Html = require("../../web/html");

const who = (role) => ({ id: "b1", role, agency_id: "a" });
const page = (role, path) => String(Html.layout({ broker: who(role), path, lang: "en", assets: (name) => name }));
const links = (html) => [...html.matchAll(/<a[^>]* href="([^"]+)"/g)].map((m) => m[1]);
const menu = (role) => String(Html.sideMenu(who(role), "home", "en"));
const tabs = (role, path) => page(role, path).match(/<nav class="tabnav hub-tabs"[^>]*>(.*?)<\/nav>/s)?.[1] ?? "";

test("manager sidebar puts role main shortcuts outside menus with no duplicates inside menus", () => {
  const html = menu("manager");
  const outside = html.split('<hr class="side-sep">')[0];
  const inside = html.split('<hr class="side-sep">')[1] || "";
  expect(links(outside)).toEqual([
    "/app/add", "/app/", "/app/units/new", "/app/team", "/app/leads", "/app/search"
  ]);
  expect(outside).toContain("Add a unit");
  for (const href of ["/app/team", "/app/leads", "/app/search"]) {
    expect(inside).not.toContain(`href="${href}"`);
  }
  expect(html).toContain("Agency Reports");
  expect(html).toContain("Inventory");
  expect(html).toContain('href="/app/dashboard"');
  expect(String(Html.sideMenu(who("manager"), "home", "ar"))).toContain("تقارير الشركة");
});

test("secondary pages stay in their section and highlight the current destination", () => {
  expect(links(tabs("manager", "/app/leads"))).toEqual([
    "/app/leads", "/app/leads/board", "/app/requests", "/app/leads?tab=portal", "/app/links", "/app/leads/import"
  ]);
  expect(tabs("manager", "/app/leads?tab=portal")).toContain('href="/app/leads?tab=portal" aria-current="page"');
  expect(page("manager", "/app/links")).toContain('<details class="side-group" data-group="clients" open>');
  expect(page("manager", "/app/links")).toContain('href="/app/links" aria-current="page"');
  expect(links(tabs("manager", "/app/deals"))).toEqual(["/app/deals", "/app/commissions", "/app/leases"]);
  expect(links(tabs("manager", "/app/dashboard"))).toContain("/app/activity-log");
  expect(links(tabs("manager", "/app/search"))).toContain("/app/insights");
});

test("section links and prominent Add unit respect role visibility without duplication", () => {
  const deHtml = menu("data_entry");
  const deOutside = deHtml.split('<hr class="side-sep">')[0];
  const deInside = deHtml.split('<hr class="side-sep">')[1] || "";
  expect(deOutside).toContain("Add a unit");
  expect(links(deOutside)).toEqual(["/app/units/new", "/app/search", "/app/units", "/app/owners", "/app/settings"]);
  for (const href of ["/app/search", "/app/units", "/app/owners", "/app/settings"]) {
    expect(deInside).not.toContain(`href="${href}"`);
  }
  expect(deInside).toContain("/app/import");
  expect(deInside).toContain("/app/insights");
  expect(links(tabs("data_entry", "/app/units"))).toEqual(["/app/units", "/app/owners", "/app/import"]);
  expect(links(tabs("broker", "/app/leads"))).not.toContain("/app/leads?tab=portal");
  expect(links(menu("broker"))).not.toContain("/app/dashboard");
  const addUnitSide = String(Html.sideMenu(who("manager"), "add", "en", { path: "/app/units/new" }));
  expect(addUnitSide).toContain('href="/app/units/new" aria-current="page"');
  expect(addUnitSide).not.toContain('href="/app/units" aria-current="page"');
  expect(addUnitSide.match(/aria-current="page"/g)).toHaveLength(1);
});

test("More lists items outside the bottom bar", () => {
  const mgr = Html.navFor(who("manager")).map((i) => i.href);
  expect(mgr).toContain("/app/deals");
  expect(mgr).toContain("/app/dashboard");
  expect(mgr).toContain("/app/import");
  expect(mgr).not.toContain("/app/leads");
  expect(Html.navFor(who("broker")).map((i) => i.href)).not.toContain("/app/units");
});

test("the bottom bar comes from the shared spec", () => {
  expect(Html.tabsFor(who("broker")).map((t) => t.key)).toEqual(["home", "leads", "search", "units", "more"]);
  expect(Html.tabsFor(who("team_lead")).map((t) => t.key)).toEqual(["home", "team", "search", "leads", "more"]);
  expect(Html.tabsFor(who("data_entry")).map((t) => t.key)).toEqual(["search", "units", "add", "owners", "settings"]);
});

test("web unit card follows the app card hierarchy and badge placement", () => {
  const { resultItem } = require("../../web/views/units");
  const card = String(resultItem({
    code: "HP-101",
    compound: "Hyde Park",
    phase_ar: "الأولى",
    phase_en: "Phase 1",
    district: "New Cairo",
    city: "Cairo",
    property_type: "apartment",
    listing_type: "sale",
    finishing: "fully_finished",
    bedrooms: 3,
    bathrooms: 2,
    area_value: 165,
    price_value: 7500000
  }, "en", { selectable: true, mine: true }));
  expect(card).toContain("uc-over-top");
  expect(card).toContain("uc-over-bottom");
  expect(card).toContain("uc-pills");
  expect(card).toContain("uc-chev");
  expect(card.indexOf("uc-title")).toBeLessThan(card.indexOf("uc-price"));
});
