// lib/failureLog.js — One operation_logs row for every refused (4xx) or failed (5xx) signed-in web request.
// Reason = the status plus the route; no query strings, bodies or values (ids and codes are masked).
"use strict";

const { logOperation } = require("./db");

const SKIP = /^\/(csrf|client-error|sw\.js|notifications\/count)$/;

/** "/units/NH-V12/edit" → "/units/:code/edit"; uuids and long numbers → ":id". */
function routeShape(path) {
  return String(path || "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/\/[A-Za-z]{1,6}-?[A-Z]?\d{1,6}(?=\/|$)/g, "/:code")
    .replace(/\d{4,}/g, ":n")
    .slice(0, 160);
}

/** Express middleware: logs on finish unless a route already traced the refusal itself (res.locals.failureTraced). */
function middleware(pool) {
  return (req, res, next) => {
    res.on("finish", () => {
      const status = res.statusCode;
      if (status < 400 || res.locals.failureTraced || SKIP.test(req.path)) return;
      const broker = req.session?.broker;
      if (!broker) return;
      logOperation(pool, {
        agency_id: broker.agency_id,
        broker_id: broker.id,
        operation_type: "web_failed",
        status: "error",
        error_code: `http_${status}`,
        metadata: { method: req.method, route: routeShape(`${req.baseUrl || ""}${req.path}`), htmx: Boolean(req.get("HX-Request")), role: broker.role || null }
      }).catch(() => {});
    });
    next();
  };
}

module.exports = { middleware, routeShape };
