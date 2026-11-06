// services/audit.js — The audit log: who did what, when, from where. Rows go into audit_logs, which the database protects
// (no changes, no deletes before 12 months). record() never throws (for events worth keeping that must not break the
// action); recordStrict() throws when the row cannot be written, so a sensitive action fails if its log fails.
"use strict";

const { AsyncLocalStorage } = require("async_hooks");

const KEEP_MONTHS = 12;
const client = new AsyncLocalStorage();
const BATCH = 1000;

/** Who is calling and from where: { ip, userAgent } from an Express request. */
function fromReq(req) {
  if (!req) return {};
  return { ip: req.ip || null, userAgent: String(req.get?.("user-agent") || "").slice(0, 200) || null };
}

/** Express middleware: audit rows written while this request runs carry its IP address and device. */
const withClient = (req, _res, next) => client.run(fromReq(req), next);

async function insert(pool, e) {
  const c = client.getStore() || {};
  e = { ip: c.ip, userAgent: c.userAgent, ...e };
  await pool.query(
    `INSERT INTO audit_logs (agency_id, broker_id, action, severity, payload, ip, user_agent, target_type, target_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
    [e.agencyId || null, e.brokerId || null, String(e.action).slice(0, 64), e.severity || "info", JSON.stringify(e.payload || {}),
      e.ip || null, e.userAgent || null, e.targetType || null, e.targetId == null ? null : String(e.targetId).slice(0, 200)]
  );
}

/** Writes one audit row; false (and a console warning) when it could not be written. */
async function record(pool, e) {
  try {
    await insert(pool, e);
    return true;
  } catch (err) {
    console.warn("Audit log write failed:", err.message, e.action);
    return false;
  }
}

/** Writes one audit row or throws: the caller's action must not go ahead without it. */
async function recordStrict(pool, e) {
  try {
    await insert(pool, e);
  } catch (err) {
    console.error("Audit log write failed (action refused):", err.message, e.action);
    const out = new Error("audit_unavailable");
    out.code = "audit_unavailable";
    throw out;
  }
}

/** Audit row for a sign-in, sign-out or passkey event that is also an operation log row (never fails the caller). */
function fromOperation(pool, p) {
  const failed = p.status === "failed";
  return record(pool, { agencyId: p.agency_id, brokerId: p.broker_id, action: p.operation_type + (failed ? " failed" : ""), severity: failed ? "warn" : "info", payload: { ...(p.metadata || {}), ...(p.error_code ? { error: p.error_code } : {}) } });
}

/** Express middleware: audits (strictly) every change request under the given paths before the handler runs. */
function auditWrites(pool, pathPattern, { exclude = null } = {}) {
  return async (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    if (!pathPattern.test(req.path) || (exclude && exclude.test(req.path))) return next();
    const b = req.session?.broker;
    try {
      await recordStrict(pool, {
        agencyId: b?.agency_id, brokerId: b?.id,
        action: `web ${req.method} ${req.path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id").replace(/\/\d+(?=\/|$)/g, "/:id")}`,
        payload: { path: req.path }, ...fromReq(req)
      });
    } catch {
      return res.status(503).type("text/plain").send(req.lang === "en" ? "Could not record this action, so it was not done. Try again shortly." : "مقدرناش نسجّل العملية فمنفذتش. جرّب تاني بعد شوية.");
    }
    return next();
  };
}

/** Deletes audit rows older than 12 months (the database refuses anything younger), in batches. */
async function cleanup(pool) {
  let removed = 0;
  for (;;) {
    const r = await pool.query(
      `DELETE FROM audit_logs WHERE id IN (SELECT id FROM audit_logs WHERE created_at < NOW() - make_interval(months => $1::int) ORDER BY created_at LIMIT $2)`,
      [KEEP_MONTHS, BATCH]
    );
    removed += r.rowCount;
    if (r.rowCount < BATCH) break;
  }
  return { removed };
}

const cleanupJob = () => ({ name: "audit_cleanup", everyMs: 24 * 3600 * 1000, run: ({ pool }) => cleanup(pool).then((counts) => ({ counts })) });

module.exports = { KEEP_MONTHS, withClient, BATCH, fromReq, record, recordStrict, fromOperation, auditWrites, cleanup, cleanupJob };
