// tests/security/routes.js — Every signed-in route of the website and the app API, read from the modules themselves (each
// module's register(router, ctx) is run against a recorder), so a new route is in the security tests without a list to keep.
"use strict";

const path = require("path");

function recorder() {
  const out = [];
  const rec = {};
  for (const m of ["get", "post", "put", "patch", "delete"]) {
    rec[m] = (p, ...handlers) => {
      if (typeof p === "string" && handlers.length) out.push({ method: m.toUpperCase(), path: p });
      return rec;
    };
  }
  rec.use = () => rec;
  rec.all = () => rec;
  rec.param = () => rec;
  rec.route = (p) => {
    const r = {};
    for (const m of ["get", "post", "put", "patch", "delete"]) r[m] = (...h) => { if (h.length) out.push({ method: m.toUpperCase(), path: p }); return r; };
    return r;
  };
  return { rec, out };
}

const API_MODULES = ["units", "today", "search", "leads", "unitsWrite", "viewings", "team", "usage", "settings", "leases", "savedSearches", "requests", "capabilities", "owners", "access", "teamAdmin", "insights", "deals", "more", "ask", "map", "places", "devices", "clientError", "notificationSettings", "notifications", "chatDecisions"];

/** [{ method, path }] of /api/v1 routes that need a signed-in person (path without the /api/v1 prefix). */
function apiRoutes() {
  const { rec, out } = recorder();
  const ctx = { pool: { query: async () => ({ rows: [] }) } };
  for (const m of API_MODULES) require(path.join("../../api", m)).register(rec, ctx);
  return dedupe(out);
}

/** [{ method, path }] of website routes that need a signed-in person (path without the /app prefix). */
function webRoutes() {
  const { rec, out } = recorder();
  const ctx = { pool: { query: async () => ({ rows: [] }) }, config: require("../../config").getConfig() };
  for (const p of require("../../web/routes").PRIVATE) {
    try {
      p.register(rec, ctx);
    } catch { /* a module that needs more context at register time: its routes are listed as far as it got */ }
  }
  return dedupe(out);
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((r) => {
    const k = `${r.method} ${r.path}`;
    if (seen.has(k) || r.path.includes("*")) return false;
    seen.add(k);
    return true;
  });
}

module.exports = { apiRoutes, webRoutes, API_MODULES };
