// lib/slowRequests.js — Slow-request log: a page that takes longer than SLOW_REQUEST_MS is stored in error_events (kind "slow") so the
// owner sees it on the Operations tab with the other problems. One row per route per minute at most; never blocks or fails a request.
"use strict";

const lastLogged = new Map(); // fingerprint → time of the last stored row

function threshold() {
  const n = Number(process.env.SLOW_REQUEST_MS);
  return n > 0 ? n : 2000;
}

/** Express middleware: times the request and stores it when it finished slowly. */
function middleware(pool) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number((process.hrtime.bigint() - start) / 1000000n);
      if (ms < threshold()) return;
      const route = `${req.method} ${req.baseUrl}${req.route?.path || req.path}`.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ":id").slice(0, 200);
      const now = Date.now();
      if (now - (lastLogged.get(route) || 0) < 60000) return;
      lastLogged.set(route, now);
      if (lastLogged.size > 500) lastLogged.clear();
      pool
        .query(
          `INSERT INTO error_events (kind, source, fingerprint, message, agency_id, broker_id, path, metadata) VALUES ('slow', 'web', $1, $2, $3, $4, $5, $6::jsonb)`,
          [`slow:${route}`, `Slow page: ${ms} ms`, req.session?.broker?.agency_id || null, req.session?.broker?.id || null, route, JSON.stringify({ ms, status: res.statusCode })]
        )
        .catch(() => {});
    });
    next();
  };
}

module.exports = { threshold, middleware };
