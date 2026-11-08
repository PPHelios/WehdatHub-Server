// api/index.js — The JSON API for the mobile app (/api/v1). Same database, rules and sessions as the website; a signed-in
// phone sends its session token as "Authorization: Bearer <token>" (no cookies, so no CSRF). Who is looking travels with
// the request (lib/visibility), exactly as on the web.
"use strict";

const express = require("express");
const WebAuth = require("../lib/webAuth");
const Vis = require("../lib/visibility");
const ErrorReports = require("../lib/errorReports");

const bearerOf = (req) => {
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(String(req.get("authorization") || ""));
  return m ? m[1] : null;
};

/** Loads req.token and req.session from the Bearer header (null when missing, unknown, expired or revoked). */
function loadBearer(pool) {
  return async (req, _res, next) => {
    try {
      req.token = bearerOf(req);
      req.session = req.token ? await WebAuth.getSession(pool, req.token) : null;
      next();
    } catch (err) {
      next(err);
    }
  };
}

function requireAuth(req, res, next) {
  if (req.session) return next();
  return res.status(401).json({ error: "unauthorized" });
}

/**
 * Mounts the API on an Express app.
 * @param {import("express").Express} app
 * @param {Object} deps - { pool, config }
 */
function mountApi(app, { pool }) {
  const api = express.Router();
  api.use((_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    next();
  });
  // The oldest app version the server still supports: an older app shows "Update the app" instead of failing in odd ways.
  // Raise APP_MIN_VERSION (e.g. 1.2.0) on Render when an API change breaks old apps. Public, no sign-in.
  api.get("/config", (_req, res) =>
    res.json({ minAppVersion: /^\d+\.\d+\.\d+$/.test(process.env.APP_MIN_VERSION || "") ? process.env.APP_MIN_VERSION : "0.0.0", storeUrl: { android: process.env.APP_STORE_URL_ANDROID || null, ios: process.env.APP_STORE_URL_IOS || null } })
  );
  api.use(loadBearer(pool));
  require("./auth").register(api, { pool });

  const priv = express.Router();
  priv.use(requireAuth);
  priv.use((req, _res, next) => Vis.run(req.session.broker, next));
  require("./units").register(priv, { pool });
  require("./today").register(priv, { pool });
  require("./search").register(priv, { pool });
  require("./leads").register(priv, { pool });
  require("./unitsWrite").register(priv, { pool });
  require("./map").register(priv, { pool });
  require("./devices").register(priv, { pool });
  api.use(priv);

  api.use((_req, res) => res.status(404).json({ error: "not_found" }));
  // eslint-disable-next-line no-unused-vars
  api.use(async (err, req, res, _next) => {
    const status = err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) await ErrorReports.capture(err, { pool, source: "http", path: `${req.method} ${req.path}` });
    if (!res.headersSent) res.status(status).json({ error: status === 500 ? "server_error" : "bad_request" });
  });
  app.use("/api/v1", api);
}

module.exports = { mountApi, requireAuth, bearerOf };
