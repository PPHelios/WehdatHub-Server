// lib/navSpec.js — The one definition of every role's menu (spec-server.md section 1). The website's side menu and bottom
// bar and the app's tabs and More list are all built from forBroker(); neither decides a menu on its own any more.
// It only says which role SEES an item. Rights stay in lib/authz.js: the server still refuses what a role may not use.
//
// Shape (also sent on /me as `nav`): { role, tabs: [{ key, label: {ar,en}, icon, web, app, fab? }],
//   groups: [{ key, label: {ar,en}, items: [{ key, label, icon, web, app, onBar }] }] }
//   web = the page path (null when the website has no such page); app = the app's screen name (null when the app has none).
// Groups in order: Clients, Listings, Find, Agency, Account; the product owner's tracking pages sit in their own group.
"use strict";

const Authz = require("./authz");

const ROLES = ["broker", "team_lead", "manager", "owner", "data_entry", "crm"];
const GROUPS = [
  { key: "clients", label: { ar: "العملاء", en: "Clients" } },
  { key: "listings", label: { ar: "الوحدات", en: "Listings" } },
  { key: "find", label: { ar: "البحث", en: "Find" } },
  { key: "agency", label: { ar: "الشركة", en: "Agency" } },
  { key: "account", label: { ar: "حسابي", en: "Account" } },
  { key: "platform", label: { ar: "المنصة", en: "Platform" } }
];

// Role sets. "Work" roles use leads and deals; data entry works on units only (Haytham, 2026-11-15: no Leases, Projects or Inbox).
const WORK = ["broker", "team_lead", "manager", "owner"];
const MGR = ["manager", "owner"];
const LEAD_UP = ["team_lead", "manager", "owner"];

// [key, ar, en, icon, group, roles, web path, app screen]
const ITEMS = [
  // First row of More and of the website's phone menu: the Add chooser. Data entry has Add on its bar instead.
  ["add", "إضافة", "Add", "plus", "clients", WORK, "/app/add", "AddUnit"],
  ["leads", "العملاء", "Leads", "leads", "clients", WORK, "/app/leads", "LeadsList"],
  ["requests", "طلبات العملاء", "Client requests", "clipboard", "clients", WORK, "/app/requests", "ClientRequests"],
  ["owners", "المُلّاك", "Owners", "key-people", "clients", [...WORK, "data_entry"], "/app/owners", "Owners"],
  ["deals", "الصفقات", "Deals", "deal", "clients", WORK, "/app/deals", "Deals"],
  ["commissions", "العمولات", "Commissions", "money", "clients", WORK, "/app/commissions", "Commissions"],
  ["calendar", "التقويم", "Calendar", "calendar", "clients", WORK, null, "Calendar"],
  ["pipeline", "مراحل العملاء", "Pipeline", "funnel", "clients", LEAD_UP, null, "Pipeline"],
  ["leases", "الإيجارات", "Leases", "key", "clients", WORK, null, "Leases"],
  ["inbox", "الوارد", "Inbox", "inbox", "clients", WORK, null, "Inbox"],

  ["units", "الوحدات", "Units", "units", "listings", [...WORK, "data_entry"], "/app/units", "UnitsList"],
  ["catalogue", "كتالوج المطورين", "Developer catalogue", "catalogue", "listings", WORK, "/app/catalogue", null],
  ["map", "الخريطة", "Map", "pin", "listings", WORK, "/app/map", "MapList"],
  ["projects", "المشاريع", "Projects", "building", "listings", WORK, null, "Projects"],
  ["library", "مكتبة المشاريع", "Project library", "folder", "listings", MGR, null, "Library"],
  ["import", "تحميل وحدات", "Import units", "import", "listings", [...WORK, "data_entry"], "/app/import", null],
  ["waimport", "تحميل من واتساب", "Import from WhatsApp", "import", "listings", [...MGR, "data_entry"], null, "WhatsAppImport"],
  ["leadimport", "تحميل عملاء", "Import leads", "user-plus", "listings", WORK, "/app/leads/import", null],

  ["search", "بحث", "Search", "search", "find", [...WORK, "data_entry"], "/app/search", "Search"],
  ["searches", "البحث المحفوظ", "Saved searches", "star", "find", WORK, "/app/searches", "SavedSearches"],
  ["ask", "اسأل المساعد", "Ask the assistant", "chat", "find", WORK, "/app/ask", "Ask"],
  ["links", "الروابط المفتوحة", "Opened links", "link", "find", WORK, "/app/links", "SentLinks"],
  ["compare", "مقارنة", "Compare", "compare", "find", WORK, "/app/compare", "Compare"],
  ["insights", "أسعار المتر", "Price per m²", "tag", "find", [...WORK, "data_entry"], "/app/insights", "Prices"],

  ["team", "الفريق", "Team", "team", "agency", LEAD_UP, "/app/team", "Team"],
  ["dashboard", "لوحة الشركة", "Agency dashboard", "chart", "agency", MGR, "/app/dashboard", "Dashboard"],
  ["sources", "مصادر العملاء وتكلفتها", "Lead sources and cost", "funnel", "agency", MGR, "/app/sources", "Sources"],
  ["winloss", "المكسب والخسارة", "Win and loss", "trend", "agency", MGR, "/app/winloss", "WinLoss"],
  // Shown only while the product owner has switched market analytics on for the agency (broker.analytics_enabled, set per page load).
  ["market", "السوق", "Market", "trend", "agency", MGR, "/app/market", null],
  ["access", "طلبات البيانات الخاصة", "Private data requests", "lock", "agency", MGR, "/app/access-requests", "Requests"],
  ["portal", "استفسارات البوابات", "Portal enquiries", "inbox", "agency", MGR, null, "Portal"],
  ["leadrules", "قواعد توزيع العملاء", "Lead rules", "settings", "agency", MGR, null, "LeadRules"],
  ["activity", "سجل النشاط", "Activity log", "book", "agency", MGR, null, "ActivityLog"],

  ["usage", "استخدامي والحصص", "My usage and limits", "gauge", "account", WORK, "/app/usage", "Usage"],
  ["settings", "الإعدادات", "Settings", "settings", "account", [...WORK, "data_entry", "crm"], "/app/settings", "Settings"],
  ["notifications", "التنبيهات", "Notifications", "bell", "account", [...WORK, "data_entry", "crm"], "/app/notifications", "Notifications"],
  ["guide", "الدليل", "Guide", "book", "account", [...WORK, "data_entry", "crm"], "/app/guide", null],
  ["report", "بلّغ عن مشكلة", "Report a problem", "bug", "account", WORK, "/app/report", "Report"],

  // The product owner (OWNER_BROKER_IDS): the app-tracking pages only.
  ["owner", "متابعة التطبيق", "App tracking", "pulse", "platform", ["crm"], "/app/owner", "Platform"],
  ["ownermap", "أماكن الخريطة", "Map places", "pin", "platform", ["crm"], "/app/owner/map", null],
  ["ownerqueue", "طابور الاعتماد", "Approval queue", "check", "platform", ["crm"], "/app/owner/queue", null],
  ["ownerlibrary", "مكتبة المشاريع", "Project library", "folder", "platform", ["crm"], "/app/owner/library", null],
  ["searchreview", "مراجعة البحث", "Search review", "search-check", "platform", ["crm"], "/app/owner/searches", null]
].map(([key, ar, en, icon, group, roles, web, app]) => Object.freeze({ key, label: Object.freeze({ ar, en }), icon, group, roles, web, app }));

// The bottom bar per role, left to right in English (Arabic flips it). `fab` is the centre + button.
const tab = (key, ar, en, icon, web, app, extra = {}) => Object.freeze({ key, label: Object.freeze({ ar, en }), icon, web, app, ...extra });
const HOME = tab("home", "اليوم", "Today", "home", "/app/", "Today");
const SEARCH = tab("search", "بحث", "Search", "search", "/app/search", "Search");
const LEADS = tab("leads", "العملاء", "Leads", "leads", "/app/leads", "Leads");
const UNITS = tab("units", "الوحدات", "Units", "units", "/app/units", "Units");
const TEAM = tab("team", "الفريق", "Team", "team", "/app/team", "Team");
const MORE = tab("more", "المزيد", "More", "more", "/app/more", "More");
const DASH = tab("dashboard", "اللوحة", "Dashboard", "chart", "/app/dashboard", "Dashboard", { fab: true });
// The centre slot is the role's main shortcut (fab): Search for brokers and team leads, Leads for managers, Dashboard for the agency owner,
// Add unit for data entry, Board for the product owner. Add for everyone else is the first row of More.
const centre = (t) => ({ ...t, fab: true });
const TABS = {
  broker: [HOME, LEADS, centre(SEARCH), UNITS, MORE],
  team_lead: [HOME, TEAM, centre(SEARCH), LEADS, MORE],
  manager: [HOME, TEAM, centre(LEADS), SEARCH, MORE],
  owner: [HOME, TEAM, DASH, LEADS, MORE],
  data_entry: [
    SEARCH,
    UNITS,
    tab("add", "إضافة", "Add", "plus", "/app/units/new", "AddUnit", { fab: true }),
    tab("owners", "المُلّاك", "Owners", "key-people", "/app/owners", "Owners"),
    tab("settings", "الإعدادات", "Settings", "settings", "/app/settings", "Settings")
  ],
  crm: [
    tab("home", "الرئيسية", "Home", "home", "/app", "Today"),
    tab("owner", "المتابعة", "Tracking", "pulse", "/app/owner", "Platform"),
    tab("board", "اللوحة", "Board", "gauge", "/app/owner/board", null, { fab: true }),
    tab("alerts", "التنبيهات", "Alerts", "bell", "/app/notifications", "Notifications"),
    tab("settings", "الإعدادات", "Settings", "settings", "/app/settings", "Settings")
  ]
};

/** The role key a person's menu follows: crm (product owner), data_entry, owner (agency owner), manager (manager or admin), team_lead, broker. */
function roleOf(broker) {
  if (Authz.isCrmOwner(broker)) return "crm";
  if (Authz.isDataEntry(broker)) return "data_entry";
  const r = String(broker?.role || "").toLowerCase();
  if (r === "owner") return "owner";
  if (r === "admin" || r === "manager") return "manager";
  if (r === "team_lead") return "team_lead";
  return "broker";
}

// Tab key -> the menu item it is also (so the menu can say the item is on the bar and More can leave it out).
const TAB_ITEM = { leads: "leads", units: "units", team: "team", search: "search", owners: "owners", settings: "settings", dashboard: "dashboard" };

/**
 * The menu for one person.
 * @param {Object} broker
 * @param {Object} [opts] - { rights } from services/unitRights.rights: data entry sees Owners only while the agency allows it.
 */
function forBroker(broker, { rights = null } = {}) {
  const role = roleOf(broker);
  const dataEntryOwners = rights ? Boolean(rights.owners) : true;
  const show = (key) => !(role === "data_entry" && key === "owners" && !dataEntryOwners) && !(key === "market" && !(broker && broker.analytics_enabled === true));
  let tabs = TABS[role].filter((t) => show(t.key));
  const onBar = new Set(tabs.map((t) => TAB_ITEM[t.key]).filter(Boolean));
  const groups = GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    items: ITEMS.filter((i) => i.group === g.key && i.roles.includes(role) && show(i.key)).map((i) => ({ key: i.key, label: i.label, icon: i.icon, web: i.web, app: i.app, onBar: onBar.has(i.key) }))
  })).filter((g) => g.items.length);
  return { role, tabs: tabs.map((t) => ({ ...t })), groups };
}

/** Every icon name the menu uses (tests check each exists on the website and in the app). */
const iconNames = () => [...new Set([...ITEMS.map((i) => i.icon), ...Object.values(TABS).flat().map((t) => t.icon)])].sort();

module.exports = { ROLES, GROUPS, ITEMS, TABS, roleOf, forBroker, iconNames };
