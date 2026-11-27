// web/html.js — Server-side HTML: an escaping tagged template and the page layout (RTL by default)
"use strict";

const { BRAND } = require("../domain/brand");

class SafeHtml {
  constructor(text) {
    this.text = text;
  }
  toString() {
    return this.text;
  }
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };

/** Escapes text for HTML content and quoted attributes. */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"'`]/g, (c) => ESC[c]);
}

function render(value) {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof SafeHtml) return value.text;
  if (Array.isArray(value)) return value.map(render).join("");
  return escapeHtml(value);
}

/** html`<p>${text}</p>`: every interpolated value is escaped unless it is already SafeHtml (or an array of it). */
function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** Marks trusted markup (never use on user input). */
const raw = (text) => new SafeHtml(String(text ?? ""));

/** A phone number kept left-to-right inside RTL text (the "+" and digits would otherwise render reversed). */
const phoneLtr = (value) => html`<bdi dir="ltr">${value}</bdi>`;
const phoneOrText = (value) => /^(?=.*\p{Nd})[+\p{Nd}\s().-]+$/u.test(value ?? "") ? phoneLtr(value) : value;

/** JSON text for an attribute; html`` escapes it once when interpolated. */
const jsonAttr = (obj) => JSON.stringify(obj);

const HTMX_CONFIG = { includeIndicatorStyles: false, allowEval: false, allowScriptTags: false, selfRequestsOnly: true, historyCacheSize: 0 };

/**
 * Full page. lang "ar" renders RTL; assets(name) gives the versioned static path.
 * @param {Object} p - { title, lang, body, assets, csrf, broker, nav, head, robots, unread }
 */
function layout({ title, lang = "ar", body, assets, csrf = null, broker = null, nav = null, head = null, robots = "noindex, nofollow", scripts = true, manifest = true, theme = false, unread = 0, langSwitch = false, path = "", aiOff = [], planBanner = null, analyticsId = null }) {
  const en = lang === "en";
  const crm = Boolean(broker) && require("../lib/authz").isCrmOwner(broker);
  const tab = broker ? (crm ? crmTabOf(path) : tabOf(path, nav)) : null;
  return html`<!doctype html>
<html lang="${en ? "en" : "ar"}" dir="${en ? "ltr" : "rtl"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="${robots}">
${analyticsId && broker && scripts ? html`<meta name="web-analytics" content="${analyticsId}" data-screen="${tab}">` : ""}
<meta name="theme-color" content="${BRAND.colors.brand}">
<meta name="htmx-config" content="${jsonAttr(HTMX_CONFIG)}">
${csrf ? html`<meta name="csrf-token" content="${csrf}">` : ""}
<title>${title ? `${title} · ${BRAND.name}` : BRAND.name}</title>
${manifest ? html`<link rel="manifest" href="/app/manifest.webmanifest">` : ""}
<link rel="icon" href="${assets(BRAND.logo)}" type="image/svg+xml">
<link rel="apple-touch-icon" href="${assets("icons/icon-192.png")}">
${scripts || theme ? html`<script src="${assets("theme.js")}"></script>
` : ""}<link rel="preload" href="${assets("fonts/cairo-400.woff2")}" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${assets("fonts/cairo-700.woff2")}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${assets("app.css")}">
${head || ""}
${scripts ? html`<script src="${assets("htmx.min.js")}" defer></script>
<script src="${assets("carousel.js")}" defer></script>
<script src="${assets("app.js")}" defer></script>
<script src="${assets("busy.js")}" defer></script>
<script src="${assets("saveBar.js")}" defer></script>
<script src="${assets("voice.js")}" defer></script>` : ""}
</head>
<body${broker ? raw(' class="has-tabbar"') : ""}${aiOff.length ? raw(` data-ai-off="${aiOff.join(",")}" data-ai-off-hint="${lang === "en" ? "Switched off by your agency owner" : "مقفول من مالك الشركة"}"`) : ""}>
${broker || nav || langSwitch ? topBar({ broker, nav, lang, unread, tab }) : ""}
${broker && planBanner ? html`<div class="plan-banner plan-${planBanner.phase}" role="alert" data-plan-banner="${planBanner.phase}">${planBanner.text}${planBanner.url ? html` <a href="${planBanner.url}">${planBanner.cta}</a>` : ""}</div>` : ""}
<main id="main">${broker ? html`${pageBar({ nav, lang, tab, path, crm })}${crm ? "" : hubTabs(broker, lang, path)}` : ""}${body}</main>
${broker ? footer(broker, lang) : ""}
${broker ? (crm ? crmTabBar(tab, lang) : tabBar(broker, tab, lang)) : ""}
${broker ? sideMenu(broker, tab, lang, { crm, path }) : ""}
<div class="toast" data-toast-box role="status" aria-live="polite" hidden></div>
</body>
</html>`;
}

// Where ← Back goes without history: a sub-page returns to its list, the rest to the home page.
const BACK = { search: "/app/search", units: "/app/units", leads: "/app/leads", deals: "/app/deals", catalogue: "/app/catalogue" };

/** Onboarding: the "?" tip of a main screen (3-4 steps, domain/onboarding.js). */
function screenTip(nav, lang) {
  const steps = require("../domain/onboarding").tip(nav, lang);
  if (!steps) return "";
  return html`<details class="tip" data-tip="${nav}"><summary aria-label="${lang === "en" ? "How this page works" : "إزاي الصفحة دي بتشتغل"}">${require("./icons").icon("help", 18)} ${lang === "en" ? "How it works" : "إزاي تستخدمها"}</summary><ol>${steps.map((s) => html`<li>${s}</li>`)}</ol></details>`;
}

/** One slim row above the page: Back on pages below a bottom-bar place, and the screen's "?" tip. */
function pageBar({ nav, lang, tab, path, crm = false }) {
  const en = lang === "en";
  // A bottom-bar place has no Back, except search results (Back returns to the search form).
  const [bare, query = ""] = String(path || "").split("?");
  const root = (crm ? CRM_ROOTS : TAB_ROOTS).has(bare.replace(/\/+$/, "") || "/app") && !(nav === "search" && /(^|&)(q|f)=/.test(query));
  const back = nav && !root ? html`<a class="backlink" data-back href="${BACK[nav] || "/app/"}">${require("./icons").icon("back", 18)} ${en ? "Back" : "رجوع"}</a>` : "";
  const tip = nav ? screenTip(nav, lang) : "";
  return back || tip ? html`<div class="pagebar">${back}${tip}</div>` : "";
}

function footer(broker, lang) {
  const en = lang === "en";
  const support = require("../services/onboarding").supportUrl(broker, lang);
  return html`<footer class="foot muted"><a href="/app/report">${en ? "Report a problem" : "بلّغ عن مشكلة"}</a>${support ? html` · <a href="${support}" target="_blank" rel="noopener" data-support>${en ? "Talk to a person" : "كلّم حد من فريقنا"}</a>` : ""}</footer>`;
}

// The menu of every role comes from lib/navSpec.js (the app reads the same data on /me): this file only draws it.
const NavSpec = require("../lib/navSpec");
// Pages that need a laptop-sized screen (the import tools): marked so the phone's More list can hide them.
const DESKTOP_ONLY = new Set(["import", "leadimport"]);
// The session's rights (data entry only) and workspace (lib/workspace.js) travel on the broker, so the website's menu matches the app's /me nav.
const forBroker = (broker) => NavSpec.forBroker(broker, { rights: broker?.rights || null, workspace: broker?.workspace || null });
const webTab = (t) => ({ key: t.key, href: t.web, ar: t.label.ar, en: t.label.en, icon: t.icon, fab: Boolean(t.fab) });

const WEB_TAB_LABELS = {
  portal: { en: "New Leads", ar: "ليدز جدد" },
  links: { en: "Shared Links", ar: "الروابط اللي اتبعتت" },
  insights: { en: "Price Insights", ar: "أسعار المتر" }
};

const WEB_SECTIONS = [
  ["Clients", "العملاء", ["leads", "pipeline", "requests", "portal", "links", "leadimport", "leases"]],
  ["Inventory", "المخزون العقاري", ["units", "owners", "catalogue", "library", "import"]],
  ["Search", "البحث", ["search", "searches", "map", "compare", "insights", "ask"]],
  ["Deals", "الصفقات", ["deals", "commissions"]],
  ["Calendar", "التقويم", ["calendar"]],
  ["Team", "الفريق", ["team", "leadrules", "access", "addteammate"]],
  ["Agency Reports", "تقارير الشركة", ["dashboard", "sources", "winloss", "market", "activity"]],
  ["Notifications", "التنبيهات", ["notifications"]],
  ["Settings", "الإعدادات", ["settings", "usage", "guide", "report"]],
  ["Platform", "المنصة", ["owner", "ownermap", "ownerqueue", "ownerlibrary", "searchreview"]]
];

const GROUP_OPEN = new Set(["clients", "inventory", "search", "agency-reports"]);
const TAB_ITEM_KEY = { leads: "leads", units: "units", team: "team", search: "search", owners: "owners", settings: "settings", dashboard: "dashboard", owner: "owner", alerts: "notifications" };

function webSections(nav) {
  const items = new Map(nav.groups.flatMap((g) => g.items).filter((i) => i.web).map((i) => [i.key, i]));
  return WEB_SECTIONS.map(([en, ar, keys]) => ({
    key: en.toLowerCase().replace(/\s+/g, "-"),
    label: { en, ar },
    items: keys.map((key) => items.get(key)).filter(Boolean).map((i) => ({
      key: i.key, href: i.key === "portal" ? "/app/leads?tab=portal" : i.web,
      ...(WEB_TAB_LABELS[i.key] || i.label), icon: i.icon, desktop: DESKTOP_ONLY.has(i.key), onBar: i.onBar
    }))
  })).filter((section) => section.items.length);
}

function currentWebItem(sections, path) {
  const [bare, query] = String(path || "").split("?");
  const current = bare.replace(/\/+$/, "");
  const items = sections.flatMap((section) => section.items);
  if (current === "/app/leads" && new URLSearchParams(query).get("tab") === "portal") {
    return items.find((item) => item.key === "portal");
  }
  return items.filter((item) => current === item.href || current.startsWith(item.href + "/"))
    .sort((a, b) => b.href.length - a.href.length)[0];
}

function moreGroups(broker) {
  return forBroker(broker)
    .groups.map((g) => ({
      key: g.key,
      label: g.label,
      items: g.items.filter((i) => i.web && !i.onBar).map((i) => ({ key: i.key, href: i.web, ar: i.label.ar, en: i.label.en, icon: i.icon, desktop: DESKTOP_ONLY.has(i.key) }))
    }))
    .filter((g) => g.items.length);
}

const navFor = (broker) => moreGroups(broker).flatMap((g) => g.items.map((i) => ({ ...i, group: g.key })));

function hubTabs(broker, lang, path) {
  const sections = webSections(forBroker(broker));
  const current = currentWebItem(sections, path);
  const tabs = sections.find((section) => section.items.includes(current))?.items;
  if (!tabs || tabs.length < 2) return "";
  return html`<nav class="tabnav hub-tabs" aria-label="${lang === "en" ? "Related pages" : "صفحات مرتبطة"}">${tabs.map((item) =>
    html`<a href="${item.href}"${item === current ? html` aria-current="page"` : ""}>${item[lang]}</a>`
  )}</nav>`;
}

// The bottom bar: five places per role (lib/navSpec.js), the centre one is the role's main shortcut.

const TAB_ROOTS = new Set(["/app", "/app/search", "/app/add", "/app/leads", "/app/units", "/app/team", "/app/dashboard", "/app/more"]);

/** Which bottom-bar place a page belongs to (by its path, else its nav key). */
function tabOf(path, nav) {
  const p = String(path || "").split("?")[0].replace(/\/+$/, "") || "/app";
  if (p === "/app") return "home";
  if (/^\/app\/(units\/new|leads\/new|deals\/new|add|import|leads\/import)(\/|$)/.test(p)) return "add";
  if (/^\/app\/(search|searches|ask|compare|map)(\/|$)/.test(p)) return "search";
  if (/^\/app\/leads(\/|$)/.test(p)) return "leads";
  if (/^\/app\/units(\/|$)/.test(p)) return "units";
  if (/^\/app\/team(\/|$)/.test(p)) return "team";
  if (/^\/app\/dashboard(\/|$)/.test(p)) return "dashboard";
  if (/^\/app\/owners(\/|$)/.test(p)) return "owners";
  if (/^\/app\/settings(\/|$)/.test(p)) return "settings";
  return nav === "search" ? "search" : nav === "leads" ? "leads" : nav === "units" ? "units" : "more";
}

function tabBar(broker, tab, lang) {
  const en = lang === "en";
  const manager = require("../services/dashboards").isManager(broker);
  const { icon } = require("./icons");
  const dataEntry = require("../lib/authz").isDataEntry(broker);
  const tabs = tabsFor(broker);
  return html`<nav class="tabbar${dataEntry ? " de" : ""}" aria-label="${en ? "Main" : "القائمة الرئيسية"}">${tabs.map((t) =>
    t.fab
      ? html`<a class="fab" href="${t.href}" aria-label="${en ? t.en : t.ar}"${t.key === tab ? raw(' aria-current="page"') : ""}>${icon(t.icon, 28)}<span class="fab-label">${en ? t.en : t.ar}</span></a>`
      : html`<a href="${t.href}" data-tab="${t.key}"${t.key === tab ? raw(' aria-current="page"') : ""}>${icon(t.icon)}<span>${en ? t.en : t.ar}</span></a>`
  )}</nav>`;
}


/** The bottom-bar places this role sees (lib/navSpec.js): the same places as the app's tabs. */
const tabsFor = (broker) => forBroker(broker).tabs.filter((t) => t.web).map(webTab);

function sideMenu(broker, tab, lang, { crm = false, path = "" } = {}) {
  const en = lang === "en";
  const { icon } = require("./icons");
  const Authz = require("../lib/authz");
  const dataEntry = Boolean(broker) && Authz.isDataEntry(broker);
  const canAddUnits = !crm && broker?.rights?.addUnits !== false;
  const nav = forBroker(broker);
  const cleanPath = String(path || "").split("?")[0].replace(/\/+$/, "") || "/app";
  const onAddUnit = cleanPath === "/app/units/new";
  const link = (n, current) => html`<a href="${n.href}"${current ? raw(' aria-current="page"') : ""}>${icon(n.icon, 20)}<span>${en ? n.en : n.ar}</span></a>`;

  // Shortcuts outside the menus: main actions per role (add unit prominent for data entry; below Home for work roles).
  const home = nav.tabs.find((t) => t.key === "home" && t.web);
  const addUnitShortcut = canAddUnits && !dataEntry
    ? { key: "addunit", itemKey: "addunit", href: "/app/units/new", icon: "plus", en: "Add a unit", ar: "إضافة وحدة" }
    : null;
  const roleShortcuts = nav.tabs
    .filter((t) => t.web && t.key !== "home" && t.key !== "add" && t.key !== "more")
    .map((t) => ({ ...webTab(t), itemKey: TAB_ITEM_KEY[t.key] || t.key }));
  const shortcuts = [
    ...(home ? [{ ...webTab(home), itemKey: "home" }] : []),
    ...(addUnitShortcut ? [addUnitShortcut] : []),
    ...roleShortcuts
  ];

  // Exclude shortcut targets from the menus below so no link is duplicated.
  const shortcutKeys = new Set(shortcuts.map((s) => s.itemKey).filter(Boolean));
  const menus = webSections(nav)
    .map((s) => ({ ...s, items: s.items.filter((i) => !shortcutKeys.has(i.key)) }))
    .filter((s) => s.items.length);

  const activeShortcut = onAddUnit && addUnitShortcut
    ? addUnitShortcut
    : shortcuts.find((s) => (s.key === "home" ? cleanPath === "/app" : cleanPath === s.href || cleanPath.startsWith(s.href + "/")) || (s.key === tab && !onAddUnit));
  const currentMenu = activeShortcut || onAddUnit
    ? null
    : currentWebItem(menus, path) || menus.flatMap((s) => s.items).find((i) => i.key === tab);

  return html`<nav class="sidemenu" aria-label="${en ? "Menu" : "القائمة"}">
  ${crm ? "" : html`<a class="side-add" href="${dataEntry ? "/app/units/new" : "/app/add"}"${dataEntry && onAddUnit ? raw(' aria-current="page"') : ""}>${icon("plus", 20)}<span>${dataEntry ? (en ? "Add a unit" : "إضافة وحدة") : (en ? "Add" : "إضافة")}</span></a>`}
  ${shortcuts.map((s) => link(s, s === activeShortcut))}
  ${menus.length ? raw('<hr class="side-sep">') : ""}
  ${menus.map((m) => {
    if (m.items.length === 1) {
      const only = m.items[0];
      return link({ ...only, ...m.label }, only === currentMenu);
    }
    const holds = m.items.includes(currentMenu);
    const open = holds || GROUP_OPEN.has(m.key);
    return html`<details class="side-group" data-group="${m.key}"${open ? raw(" open") : ""}><summary aria-expanded="${open ? "true" : "false"}">${m.label[en ? "en" : "ar"]}</summary>${m.items.map((n) => link(n, n === currentMenu))}</details>`;
  })}
</nav>`;
}

// The CRM owner's own bottom bar: Home · Tracking · Board · Alerts · Settings.
const CRM_BAR = NavSpec.TABS.crm.map(webTab);
const CRM_ROOTS = new Set(["/app", "/app/owner", "/app/owner/board", "/app/notifications", "/app/settings", "/app/more"]);

/** Which place of the CRM owner's bar a page belongs to. */
function crmTabOf(path) {
  const p = String(path || "").split("?")[0].replace(/\/+$/, "") || "/app";
  if (p === "/app") return "home";
  if (/^\/app\/owner\/board(\/|$)/.test(p)) return "board";
  if (/^\/app\/owner(\/|$)/.test(p)) return "owner";
  if (/^\/app\/notifications(\/|$)/.test(p)) return "alerts";
  if (/^\/app\/settings(\/|$)/.test(p)) return "settings";
  return "more";
}

function crmTabBar(tab, lang) {
  const en = lang === "en";
  const { icon } = require("./icons");
  return html`<nav class="tabbar crm" aria-label="${en ? "Main" : "القائمة الرئيسية"}">${CRM_BAR.map(
    (t) => html`<a href="${t.href}" data-tab="${t.key}"${t.key === tab ? raw(' aria-current="page"') : ""}>${icon(t.icon)}<span>${en ? t.en : t.ar}</span></a>`
  )}</nav>`;
}

function testRoleForm(broker, lang) {
  const en = lang === "en";
  const TestRole = require("../lib/testRole");
  const names = { owner: en ? "Owner" : "مالك", manager: en ? "Manager" : "مدير", team_lead: en ? "Team lead" : "قائد فريق", broker: en ? "Broker" : "بروكر", data_entry: en ? "Data entry" : "مدخل بيانات" };
  return html`<form method="post" action="/app/test-role" class="test-role" data-test-role><label><span class="sr-only">${en ? "Test role" : "دور التجربة"}</span><select name="role" data-autosubmit>${TestRole.ROLES.map((r) => html`<option value="${r}"${r === (broker.home_role || broker.role) ? raw(" selected") : ""}>${names[r]}</option>`)}</select></label><noscript><button type="submit">✓</button></noscript></form>`;
}

function viewAgencyForm(broker, lang) {
  const en = lang === "en";
  const on = Boolean(broker.view_of);
  return html`<form method="post" action="/app/test-view" class="test-role" data-test-role><label><span class="sr-only">${en ? "Agency" : "الشركة"}</span><select name="view" data-autosubmit><option value="home"${on ? "" : raw(" selected")}>${en ? "Test agency" : "شركة التجربة"}</option><option value="other"${on ? raw(" selected") : ""}>${en ? "NCH (read only)" : "NCH (للقراءة فقط)"}</option></select></label><noscript><button type="submit">✓</button></noscript></form>`;
}

/** The brand name and mark that link home (translate="no": the product name is never machine-translated). */
function brandLink(href, lang, { label = false } = {}) {
  const en = lang === "en";
  const { MARK } = require("./icons");
  return html`<a class="brand" translate="no" href="${href}"${label ? html` aria-label="${en ? "WehdatHub" : "وحدات هب"}"` : ""}>${MARK}${en ? html`<span dir="ltr">Wehdat<b>Hub</b></span>` : html`<span>وحدات <b>هب</b></span>`}</a>`;
}

/** The light/dark switch of the top bar (web/static/theme.js drives it). */
function themeToggle(lang) {
  const en = lang === "en";
  const { icon } = require("./icons");
  return html`<button type="button" class="iconbtn theme-toggle" data-theme-toggle aria-label="${en ? "Switch theme" : "تبديل المظهر"}"><span class="ico-sun">${icon("sun", 20)}</span><span class="ico-moon">${icon("moon", 20)}</span></button>`;
}

function topBar({ broker, nav, lang, unread = 0, tab = null }) {
  const en = lang === "en";
  const { icon } = require("./icons");
  const TestRole = require("../lib/testRole");
  return html`<header class="top">
  ${brandLink(broker ? "/app/" : "/", lang, { label: true })}
  ${broker && TestRole.canSwitch(broker) && (TestRole.canView(broker) || broker.view_of) ? viewAgencyForm(broker, lang) : ""}
  ${broker && TestRole.canSwitch(broker) ? testRoleForm(broker, lang) : ""}
  ${themeToggle(lang)}
  ${broker
    ? html`<a class="iconbtn bell" id="inbox-bell" href="/app/notifications" aria-label="${en ? "Notifications" : "التنبيهات"}${unread ? ` (${unread > 99 ? "99+" : unread})` : ""}"${nav === "notifications" ? raw(' aria-current="page"') : ""}>${icon("bell")}${unread ? html`<span class="badge" data-unread="${unread}">${unread > 99 ? "99+" : unread}</span>` : ""}</a>
  <a class="iconbtn" href="${tab === "more" ? "/app/" : "/app/more"}" aria-label="${tab === "more" ? (en ? "Close menu" : "إغلاق القائمة") : (en ? "More" : "المزيد")}"${tab === "more" ? raw(' aria-current="page" data-menu-close') : ""}>${icon("more")}</a>`
    : html`<a class="lang" data-lang-switch href="?lang=${en ? "ar" : "en"}" hreflang="${en ? "ar" : "en"}" lang="${en ? "ar" : "en"}">${en ? "عربي" : "English"}</a>`}
</header>`;
}

/**
 * Gives every POST form of a signed-in page the session's CSRF field (unless it already has one), so a plain
 * form submit passes verifyCsrf like htmx requests do. One field per form: a second would make `_csrf` an array.
 */
function withCsrf(pageHtml, csrf) {
  if (!csrf) return String(pageHtml);
  const field = `<input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">`;
  return String(pageHtml).replace(/<form\b[^>]*\bmethod="post"[^>]*>[\s\S]*?<\/form>/gi, (form) =>
    form.includes('name="_csrf"') ? form : form.replace(">", `>${field}`)
  );
}

module.exports = { sideMenu, tabsFor, moreGroups, SafeHtml, html, raw, phoneLtr, phoneOrText, escapeHtml, jsonAttr, layout, themeToggle, brandLink, withCsrf, navFor, tabOf, HTMX_CONFIG };
