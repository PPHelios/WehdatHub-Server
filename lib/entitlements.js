// lib/entitlements.js — Server-side gate for the features of domain/segments.js FEATURES. A feature the workspace does not get is
// hidden from the menus (lib/navSpec.js) AND refused here: web() and api() answer 403 `plan_feature` with ONE plain upgrade line;
// assertAllowed() does the same inside the services the bot and the API reach. Never a dead end: the line says what to do.
// Agency tier and pilots allow every feature, so nothing changes for them. Mode only hides; roles in lib/authz.js still decide who may.
// Prices are never shown here (a broker never sees them, lib/planGuard.js); the owner gets the link to the Plan page.
"use strict";

const Segments = require("../domain/segments");
const Workspace = require("./workspace");
const { L } = require("./copy");

// feature → the paths it owns (web: relative to /app, api: relative to /api/v1). A request that matches a feature the workspace
// does not get is refused. Features with no path (dataEntry) are enforced inside the services only.
const PATHS = {
  assignLeads: { web: [/^\/leads\/[^/]+\/assign$/], api: [/^\/leads\/[^/]+\/assign$/] },
  teamPage: { web: [/^\/team(\/|$)/], api: [/^\/team(\/|$)/] },
  accessRequests: { web: [/^\/access-requests(\/|$)/, /^\/units\/[^/]+\/access(\/|$)/], api: [/^\/access-requests(\/|$)/, /^\/units\/[^/]+\/access-request$/] },
  brokersEdit: { web: [/^\/dashboard\/brokers-edit-units$/], api: [] },
  seeAll: { web: [/^\/dashboard\/brokers-see-all-leads$/], api: [] },
  leadRules: { web: [/^\/team\/(rules|routing|[^/]+\/away)$/], api: [/^\/team\/(rules|routing|[^/]+\/away)$/] },
  teamLead: { web: [/^\/team\/[^/]+\/(team-role|team)$/], api: [/^\/team\/[^/]+\/(team-role|team)$/] },
  dataEntry: { web: [], api: [] },
  sources: { web: [/^\/sources(\/|$)/], api: [/^\/sources(\/|$)/] },
  winLoss: { web: [/^\/winloss(\/|$)/], api: [/^\/insights\/winloss$/] },
  privateUnits: { web: [/^\/units\/[^/]+\/portfolio$/], api: [/^\/owners\/[^/]+\/portfolio$/, /^\/portfolio\/[^/]+\/[^/]+$/] }
};

/** The features a request path belongs to. surface: "web" | "api". */
const featuresOf = (surface, path) => Object.keys(PATHS).filter((f) => PATHS[f][surface].some((r) => r.test(path)));

/** The ONE upgrade line (the owner is pointed to the Plan page, everybody else to the owner). */
function upgradeLine(lang, { owner = false } = {}) {
  return owner
    ? L(lang, "الميزة دي مش في باقتك الحالية. رقّي الباقة من صفحة الباقة.", "This is not in your current plan. Upgrade your plan on the Plan page.")
    : L(lang, "الميزة دي مش في باقة الشركة. اطلب من صاحب الشركة.", "This is not in your company's plan. Ask the company owner.");
}

const isOwner = (b) => String(b?.role || "").toLowerCase() === "owner";
const langOf = (b) => (b?.preferred_lang === "en" ? "en" : "ar");

async function workspaceOf(pool, broker) {
  return broker.workspace || (await Workspace.stateOf(pool, broker.agency_id, { role: broker.role }).catch(() => null));
}

/** The first feature in `features` this broker's workspace does not get, or null. No workspace known (or no agency) → nothing is hidden. */
async function blocked(pool, broker, features) {
  if (!broker?.agency_id || !features.length) return null;
  const ws = await workspaceOf(pool, broker);
  return ws ? features.find((f) => !Segments.allows(ws, f)) || null : null;
}

/** For services (also reached by the bot): { error: "plan_feature", feature } when the workspace does not get the feature, else null. */
async function assertAllowed(pool, broker, feature) {
  const f = await blocked(pool, broker, [feature]);
  return f ? { error: "plan_feature", feature: f } : null;
}

/** Express middleware for the private web router (after planGuard). `page` renders a full page (web/index.js). */
function web(pool, { page = null } = {}) {
  return async (req, res, next) => {
    try {
      const broker = req.session?.broker;
      const feature = broker && (await blocked(pool, broker, featuresOf("web", req.path)));
      if (!feature) return next();
      const lang = req.lang === "en" ? "en" : "ar";
      const text = upgradeLine(lang, { owner: isOwner(broker) });
      if (req.method === "GET" && !req.get("HX-Request") && page) {
        const { html } = require("../web/html");
        return page(req, res, { title: L(lang, "مش في باقتك", "Not in your plan"), body: html`<div class="card notice" data-plan-feature="${feature}"><h1>${text}</h1>${isOwner(broker) ? html`<p><a class="btn" href="/app/usage#plan">${L(lang, "صفحة الباقة", "Plan page")}</a></p>` : ""}</div>` }, 403);
      }
      return res.status(403).type("text/plain").send(text);
    } catch (err) {
      return next(err);
    }
  };
}

/** Express middleware for the app's private API router (after planGuard). */
function api(pool) {
  return async (req, res, next) => {
    try {
      const broker = req.session?.broker;
      const feature = broker && (await blocked(pool, broker, featuresOf("api", req.path)));
      if (!feature) return next();
      return res.status(403).json({ error: "plan_feature", feature, message: upgradeLine(langOf(broker), { owner: isOwner(broker) }) });
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { PATHS, featuresOf, upgradeLine, assertAllowed, web, api };
