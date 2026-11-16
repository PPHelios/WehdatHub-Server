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

/** JSON text for an attribute; html`` escapes it once when interpolated. */
const jsonAttr = (obj) => JSON.stringify(obj);

const HTMX_CONFIG = { includeIndicatorStyles: false, allowEval: false, allowScriptTags: false, selfRequestsOnly: true, historyCacheSize: 0 };

/**
 * Full page. lang "ar" renders RTL; assets(name) gives the versioned static path.
 * @param {Object} p - { title, lang, body, assets, csrf, broker, nav, head, robots, unread }
 */
function layout({ title, lang = "ar", body, assets, csrf = null, broker = null, nav = null, head = null, robots = "noindex, nofollow", scripts = true, manifest = true, unread = 0, langSwitch = false, path = "", aiOff = [] }) {
  const en = lang === "en";
  const crm = Boolean(broker) && require("../lib/authz").isCrmOwner(broker);
  const tab = broker ? (crm ? crmTabOf(path) : tabOf(path, nav)) : null;
  return html`<!doctype html>
<html lang="${en ? "en" : "ar"}" dir="${en ? "ltr" : "rtl"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="${robots}">
<meta name="theme-color" content="${BRAND.colors.brand}">
<meta name="htmx-config" content="${jsonAttr(HTMX_CONFIG)}">
${csrf ? html`<meta name="csrf-token" content="${csrf}">` : ""}
<title>${title ? `${title} · WehdatHub` : "WehdatHub"}</title>
${manifest ? html`<link rel="manifest" href="/app/manifest.webmanifest">` : ""}
<link rel="icon" href="${assets(BRAND.logo)}" type="image/svg+xml">
<link rel="apple-touch-icon" href="${assets("icons/icon-192.png")}">
<link rel="stylesheet" href="${assets("brand.css")}">
<link rel="stylesheet" href="${assets("app.css")}">
${head || ""}
${scripts ? html`<script src="${assets("htmx.min.js")}" defer></script>
<script src="${assets("carousel.js")}" defer></script>
<script src="${assets("app.js")}" defer></script>
<script src="${assets("busy.js")}" defer></script>
<script src="${assets("voice.js")}" defer></script>` : ""}
</head>
<body${broker ? raw(' class="has-tabbar"') : ""}${aiOff.length ? raw(` data-ai-off="${aiOff.join(",")}" data-ai-off-hint="${lang === "en" ? "Switched off by your agency owner" : "مقفول من مالك الشركة"}"`) : ""}>
${broker || nav || langSwitch ? topBar({ broker, nav, lang, unread, tab }) : ""}
<main id="main">${broker ? pageBar({ nav, lang, tab, path, crm }) : ""}${body}</main>
${broker ? footer(broker, lang) : ""}
${broker ? (crm ? crmTabBar(tab, lang) : tabBar(broker, tab, lang)) : ""}
${broker ? sideMenu(broker, tab, lang, { crm }) : ""}
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
const webTab = (t) => ({ key: t.key, href: t.web, ar: t.label.ar, en: t.label.en, icon: t.icon, fab: Boolean(t.fab) });

/**
 * The More page links for this broker, grouped: what the website has a page for, minus what is already on the bottom bar.
 * [{ key, label: {ar,en}, items: [{ key, href, ar, en, icon, desktop }] }], groups in the spec order, empty groups left out.
 */
function moreGroups(broker) {
  return NavSpec.forBroker(broker)
    .groups.map((g) => ({
      key: g.key,
      label: g.label,
      items: g.items.filter((i) => i.web && !i.onBar).map((i) => ({ key: i.key, href: i.web, ar: i.label.ar, en: i.label.en, icon: i.icon, desktop: DESKTOP_ONLY.has(i.key) }))
    }))
    .filter((g) => g.items.length);
}
/** The flat list of the More page links (kept for callers that want one list). */
const navFor = (broker) => moreGroups(broker).flatMap((g) => g.items.map((i) => ({ ...i, group: g.key })));

// The bottom bar: five places. Brokers: Today · Search · + · Leads · Units; managers swap Units for Team.
// Units stays one tap away for managers under More, and inside Search as "My units".
const TAB_ROOTS = new Set(["/app", "/app/search", "/app/add", "/app/leads", "/app/units", "/app/team", "/app/more"]);

/** Which bottom-bar place a page belongs to (by its path, else its nav key). */
function tabOf(path, nav) {
  const p = String(path || "").split("?")[0].replace(/\/+$/, "") || "/app";
  if (p === "/app") return "home";
  if (/^\/app\/(units\/new|leads\/new|deals\/new|add|import|leads\/import)(\/|$)/.test(p)) return "add";
  if (/^\/app\/(search|searches|ask|compare|map)(\/|$)/.test(p)) return "search";
  if (/^\/app\/leads(\/|$)/.test(p)) return "leads";
  if (/^\/app\/units(\/|$)/.test(p)) return "units";
  if (/^\/app\/team(\/|$)/.test(p)) return "team";
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
const tabsFor = (broker) => NavSpec.forBroker(broker).tabs.filter((t) => t.web).map(webTab);

// Groups that start open before the person's own choice (kept in the browser, web/static/app.js) is applied.
const GROUP_OPEN = new Set(["clients", "listings"]);

/**
 * The laptop side menu: Today and Add, then the role's groups (Clients, Listings, Find, Agency, Account), each one a
 * <details> that works without script; the browser remembers which are open. The group holding the current page starts open.
 * Hidden under 1024px (the bottom bar and the More page are used there).
 */
function sideMenu(broker, tab, lang, { crm = false } = {}) {
  const en = lang === "en";
  const { icon } = require("./icons");
  const nav = NavSpec.forBroker(broker);
  const link = (n, current) => html`<a href="${n.href}"${current ? raw(' aria-current="page"') : ""}>${icon(n.icon, 20)}<span>${en ? n.en : n.ar}</span></a>`;
  const home = nav.tabs.find((t) => t.key === "home" && t.web);
  const groups = nav.groups
    .map((g) => ({ ...g, items: g.items.filter((i) => i.web).map((i) => ({ key: i.key, href: i.web, ar: i.label.ar, en: i.label.en, icon: i.icon })) }))
    .filter((g) => g.items.length);
  return html`<nav class="sidemenu" aria-label="${en ? "Menu" : "القائمة"}">
  ${crm ? "" : html`<a class="side-add" href="${broker && require("../lib/authz").isDataEntry(broker) ? "/app/units/new" : "/app/add"}">${icon("plus", 20)}<span>${en ? "Add" : "إضافة"}</span></a>`}
  ${home ? link(webTab(home), home.key === tab) : ""}
  ${groups.map((g) => {
    const holds = g.items.some((i) => i.key === tab);
    const open = holds || GROUP_OPEN.has(g.key);
    return html`<details class="side-group" data-group="${g.key}"${open ? raw(" open") : ""}><summary aria-expanded="${open ? "true" : "false"}">${en ? g.label.en : g.label.ar}</summary>${g.items.map((n) => link(n, n.key === tab))}</details>`;
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

function topBar({ broker, nav, lang, unread = 0, tab = null }) {
  const en = lang === "en";
  const { icon, MARK } = require("./icons");
  const TestRole = require("../lib/testRole");
  return html`<header class="top">
  <a class="brand" href="${broker ? "/app/" : "/"}" aria-label="${en ? "Wehdat Hub" : "وحدات هب"}">${MARK}${en ? html`<span dir="ltr">Wehdat <b>Hub</b></span>` : html`<span>وحدات <b>هب</b></span>`}</a>
  ${broker && TestRole.canSwitch(broker) && (TestRole.canView(broker) || broker.view_of) ? viewAgencyForm(broker, lang) : ""}
  ${broker && TestRole.canSwitch(broker) ? testRoleForm(broker, lang) : ""}
  ${broker
    ? html`<a class="iconbtn bell" href="/app/notifications" aria-label="${en ? "Notifications" : "التنبيهات"}"${nav === "notifications" ? raw(' aria-current="page"') : ""}>${icon("bell")}${unread ? html`<span class="badge" data-unread="${unread}">${unread > 99 ? "99+" : unread}</span>` : ""}</a>
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

module.exports = { sideMenu, tabsFor, moreGroups, SafeHtml, html, raw, escapeHtml, jsonAttr, layout, withCsrf, navFor, tabOf, HTMX_CONFIG };
