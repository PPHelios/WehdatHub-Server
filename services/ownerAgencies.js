// services/ownerAgencies.js — The app owner's control over agencies (OWNER_BROKER_IDS only; the route checks):
// every agency at a glance, one agency's page, changing its plan or paid-until date, pilot on/off, suspending and
// resuming it (its brokers stop working and come back as they were), an announcement to every manager, and a log of
// the owner's own actions. Prices stay in domain/plans.js.
"use strict";

const Plans = require("../domain/plans");
const Billing = require("./billing");
const Notifications = require("../lib/notifications");
const { withTransaction, logOperation } = require("../lib/db");
const Vis = require("../lib/visibility");

const DAY = 86400000;
const ACTIONS = ["owner_plan", "owner_suspend", "owner_resume", "owner_announcement", "owner_founding", "owner_extra_seats"];
// The first agencies on the Founding Partner list (flag set here; the extras are operational: no setup fee, migration help).
const FOUNDING_MAX = 20;

/** Every approved or pending agency with its plan in force and its size. */
async function list(db, { now = new Date() } = {}) {
  const { rows } = await db.query(
    `SELECT a.id, a.name, a.plan, a.paid_until, a.trial_ends_at, a.pilot, a.approval, a.created_at, a.signed_up_at, a.grace_extra_until, a.extra_seats, a.founding_partner, a.lock_until, a.locked_prices IS NOT NULL AS price_locked,
            (SELECT p.months FROM payments p WHERE p.agency_id = a.id AND p.kind = 'plan' AND p.status = 'confirmed' ORDER BY p.confirmed_at DESC NULLS LAST LIMIT 1) AS last_months,
            (SELECT min(p.created_at) FROM payments p WHERE p.agency_id = a.id AND p.kind = 'plan' AND p.status = 'pending') AS pending_plan_at,
            a.crm_settings->>'suspended_at' AS suspended_at,
            (SELECT count(*)::int FROM brokers b WHERE b.agency_id = a.id AND b.is_active) AS brokers,
            (SELECT count(*)::int FROM listings l WHERE ${Vis.allUnits()} AND l.agency_id = a.id AND l.status = 'active') AS units,
            (SELECT count(*)::int FROM leads x WHERE ${Vis.allLeads()} AND x.agency_id = a.id AND x.created_at > $1::timestamptz - interval '30 days') AS leads30,
            (SELECT max(o.created_at) FROM operation_logs o WHERE o.agency_id = a.id) AS last_seen
       FROM agencies a WHERE a.approval <> 'rejected' ORDER BY a.name`,
    [now.toISOString()]
  );
  return rows.map((a) => ({ ...a, effective: Billing.effectivePlan(a, now) }));
}

/** One agency with its brokers and recent payments. */
async function get(db, agencyId, { now = new Date() } = {}) {
  const all = await list(db, { now });
  const a = all.find((x) => x.id === agencyId);
  if (!a) return null;
  const [{ rows: brokers }, payments] = await Promise.all([
    db.query("SELECT id, name, role, is_active, preferred_lang, created_at FROM brokers WHERE agency_id = $1 ORDER BY role, name", [agencyId]),
    Billing.paymentsOf(db, agencyId, { limit: 10 })
  ]);
  return { ...a, team: brokers, payments };
}

/** Change an agency's plan: a paid plan until a date (or N months from today), or pilot on/off. */
async function setPlan(db, owner, agencyId, { plan, months = null, until = null, pilot = null, now = new Date() } = {}) {
  const p = Plans.planById(plan);
  if (!p || p.id === "free") return { error: "invalid", field: "plan" };
  let paidUntil = null;
  if (until) {
    const d = new Date(`${until}T23:59:59+02:00`);
    if (Number.isNaN(d.getTime())) return { error: "invalid", field: "until" };
    paidUntil = d;
  } else if (months !== null && months !== "") {
    const m = Number(months);
    if (!Number.isInteger(m) || m < 0 || m > 36) return { error: "invalid", field: "months" };
    paidUntil = m === 0 ? null : new Date(now.getTime() + m * 30 * DAY);
  }
  const { rows } = await db.query(
    `UPDATE agencies SET plan = $2, paid_until = $3, pilot = COALESCE($4, pilot), updated_at = now()
      WHERE id = $1 RETURNING id, name, plan, paid_until, pilot`,
    [agencyId, p.id, paidUntil ? paidUntil.toISOString() : null, pilot === null ? null : Boolean(pilot)]
  );
  if (!rows[0]) return { error: "not_found" };
  require("../lib/planGuard").forget(agencyId);
  logOperation(db, { agency_id: agencyId, broker_id: owner.id, operation_type: "owner_plan", status: "success", metadata: { plan: p.id, paid_until: rows[0].paid_until, pilot: rows[0].pilot } });
  return { ok: true, agency: rows[0] };
}

/** How many agencies are Founding Partners now: { used, max }. */
async function foundingCount(db) {
  const { rows } = await db.query("SELECT count(*)::int AS n FROM agencies WHERE founding_partner");
  return { used: rows[0].n, max: FOUNDING_MAX };
}

/**
 * The platform owner switches the Founding Partner flag of an agency on or off. Turning it on is refused (error "full") once 20
 * agencies hold it; turning it on again for one that already has it is not counted twice.
 */
async function setFounding(pool, owner, agencyId, on) {
  const out = await withTransaction(pool, async (client) => {
    // One lock for the count, so two owners' clicks cannot both take the last place.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('founding_partner'))");
    const { rows } = await client.query("SELECT founding_partner FROM agencies WHERE id = $1 FOR UPDATE", [agencyId]);
    if (!rows[0]) return { error: "not_found" };
    const want = Boolean(on);
    if (want && !rows[0].founding_partner) {
      const { used } = await foundingCount(client);
      if (used >= FOUNDING_MAX) return { error: "full", used, max: FOUNDING_MAX };
    }
    await client.query("UPDATE agencies SET founding_partner = $2, updated_at = now() WHERE id = $1", [agencyId, want]);
    return { ok: true, founding: want, ...(await foundingCount(client)) };
  });
  if (out.ok) require("../lib/planGuard").forget(agencyId);
  if (out.ok) logOperation(pool, { agency_id: agencyId, broker_id: owner.id, operation_type: "owner_founding", status: "success", metadata: { founding: out.founding } });
  return out;
}

/** The platform owner adds extra seats to an agency (services/billing.js addExtraSeats) and the action is logged. */
async function addExtraSeats(pool, owner, agencyId, seats, { now = new Date() } = {}) {
  const out = await Billing.addExtraSeats(pool, owner, agencyId, seats, { now });
  if (out.ok) logOperation(pool, { agency_id: agencyId, broker_id: owner.id, operation_type: "owner_extra_seats", status: "success", metadata: { seats: out.payment.seats, reference: out.payment.reference, amount_egp: out.payment.amount_egp, extra_seats: out.extraSeats } });
  return out;
}

/** Suspend: every active broker stops working (remembered so resume brings back the same people). */
async function suspend(pool, owner, agencyId, { now = new Date() } = {}) {
  const out = await withTransaction(pool, async (client) => {
    const { rows } = await client.query("SELECT crm_settings FROM agencies WHERE id = $1 FOR UPDATE", [agencyId]);
    if (!rows[0]) return { error: "not_found" };
    if (rows[0].crm_settings?.suspended_at) return { error: "already" };
    const { rows: off } = await client.query("UPDATE brokers SET is_active = false WHERE agency_id = $1 AND is_active RETURNING id", [agencyId]);
    await client.query(
      "UPDATE agencies SET crm_settings = crm_settings || jsonb_build_object('suspended_at', $2::text, 'suspended_brokers', $3::jsonb), updated_at = now() WHERE id = $1",
      [agencyId, now.toISOString(), JSON.stringify(off.map((b) => b.id))]
    );
    return { ok: true, brokers: off.length };
  });
  if (out.ok) logOperation(pool, { agency_id: agencyId, broker_id: owner.id, operation_type: "owner_suspend", status: "success", metadata: { brokers: out.brokers } });
  return out;
}

async function resume(pool, owner, agencyId) {
  const out = await withTransaction(pool, async (client) => {
    const { rows } = await client.query("SELECT crm_settings FROM agencies WHERE id = $1 FOR UPDATE", [agencyId]);
    if (!rows[0]) return { error: "not_found" };
    const ids = rows[0].crm_settings?.suspended_brokers || [];
    if (!rows[0].crm_settings?.suspended_at) return { error: "not_suspended" };
    const { rowCount } = await client.query("UPDATE brokers SET is_active = true WHERE agency_id = $1 AND id = ANY($2::uuid[])", [agencyId, ids]);
    await client.query("UPDATE agencies SET crm_settings = crm_settings - 'suspended_at' - 'suspended_brokers', updated_at = now() WHERE id = $1", [agencyId]);
    return { ok: true, brokers: rowCount };
  });
  if (out.ok) logOperation(pool, { agency_id: agencyId, broker_id: owner.id, operation_type: "owner_resume", status: "success", metadata: { brokers: out.brokers } });
  return out;
}

/** An announcement to every active manager (inbox, plus Telegram/WhatsApp by their settings). */
async function announce(pool, owner, { title, body = "", now = new Date() } = {}) {
  const t = String(title || "").trim().slice(0, 120);
  if (!t) return { error: "invalid", field: "title" };
  const b = String(body || "").trim().slice(0, 600);
  const { rows: agencies } = await pool.query("SELECT id FROM agencies WHERE approval = 'approved'");
  const key = `announce:${now.getTime()}`;
  let sent = 0;
  for (const a of agencies) {
    for (const m of await Notifications.managersOf(pool, a.id)) {
      await Notifications.notifyBroker(pool, m, { kind: "manager_alert", dedupeKey: key, title: `📢 ${t}`, body: b, url: "/app/notifications", now }).catch(() => {});
      sent += 1;
    }
  }
  logOperation(pool, { agency_id: null, broker_id: owner.id, operation_type: "owner_announcement", status: "success", metadata: { title: t, sent } });
  return { ok: true, sent };
}

/** The owner's own actions, newest first. */
async function auditLog(db, { limit = 50 } = {}) {
  const { rows } = await db.query(
    `SELECT o.created_at, o.operation_type, o.metadata, a.name AS agency FROM operation_logs o LEFT JOIN agencies a ON a.id = o.agency_id
      WHERE o.operation_type = ANY($1::text[]) ORDER BY o.created_at DESC LIMIT $2`,
    [ACTIONS, limit]
  );
  return rows;
}

module.exports = { ACTIONS, FOUNDING_MAX, foundingCount, setFounding, addExtraSeats, list, get, setPlan, suspend, resume, announce, auditLog };
