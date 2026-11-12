// api/clientError.js — Errors caught inside the app (a crash in a screen, a request that could not reach the server):
// stored in error_events like the website's script errors and alerted to the owner, 20 an hour per person.
"use strict";

const ErrorReports = require("../lib/errorReports");
const RateLimit = require("../lib/rateLimit");

function register(api, { pool }) {
  api.post("/client-error", async (req, res) => {
    const { broker } = req.session;
    const gate = await RateLimit.hit(pool, `client_error:${broker.id}`, { limit: 20, windowSec: 3600 }).catch(() => ({ allowed: false }));
    if (!gate.allowed) return res.sendStatus(204);
    const b = req.body || {};
    const err = { name: "AppError", message: String(b.message || "unknown").slice(0, 500), stack: b.stack ? String(b.stack).slice(0, 2000) : null };
    await ErrorReports.capture(err, {
      pool,
      source: "app",
      broker,
      path: String(b.screen || "").replace(/\?.*$/, "").slice(0, 200) || null,
      metadata: { channel: "app", platform: String(b.platform || "").slice(0, 10), appVersion: String(b.appVersion || "").slice(0, 20) }
    });
    return res.sendStatus(204);
  });
}

module.exports = { register };
