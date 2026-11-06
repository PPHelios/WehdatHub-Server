// services/accessQueue.js — The private-details requests of one agency in one list: who asked for which unit, and the answer.
// Managers read it; whoever may answer (unitPrivacy.mayDecide) approves or declines from here. Brokers never see it.
"use strict";

const { isManager } = require("../lib/authz");
const Privacy = require("./unitPrivacy");
const Vis = require("../lib/visibility");

const STATUSES = ["pending", "approved", "declined"];

async function figures(pool, agencyId, from, to) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS asked, count(*) FILTER (WHERE status = 'approved')::int AS approved, count(*) FILTER (WHERE status = 'declined')::int AS declined,
            avg(extract(epoch FROM decided_at - created_at) / 3600) FILTER (WHERE decided_at IS NOT NULL) AS hours
       FROM unit_access_requests WHERE agency_id = $1 AND created_at >= $2 AND created_at < $3`,
    [agencyId, from, to]
  );
  return { ...rows[0], hours: rows[0].hours == null ? null : Math.round(Number(rows[0].hours) * 10) / 10 };
}

/** The period's figures, the one before it, and what waits now (all time) with the oldest wait in hours. */
async function summary(pool, actor, p, now = new Date()) {
  if (!isManager(actor)) return null;
  const [cur, prev, wait] = await Promise.all([
    figures(pool, actor.agency_id, p.from, p.to),
    figures(pool, actor.agency_id, p.prevFrom, p.prevTo),
    pool.query("SELECT count(*)::int AS n, min(created_at) AS oldest FROM unit_access_requests WHERE agency_id = $1 AND status = 'pending'", [actor.agency_id]).then((x) => x.rows[0])
  ]);
  return { cur, prev, pending: wait.n, oldestHours: wait.oldest ? Math.floor((now.getTime() - new Date(wait.oldest).getTime()) / 3600000) : null, canAnswer: await Privacy.mayDecide(pool, actor) };
}

/** Requests in the window by status (pending | approved | declined | all) and text (broker or unit code). → { rows, total } */
async function list(pool, actor, { from, to, status = "pending", q = "", offset = 0, limit = 20 }) {
  if (!isManager(actor)) return { rows: [], total: 0 };
  const w = ["r.agency_id = $1", "r.created_at >= $2", "r.created_at < $3"];
  const args = [actor.agency_id, from, to];
  if (STATUSES.includes(status)) w.push(`r.status = $${args.push(status)}`);
  if (q) {
    const like = `%${String(q).replace(/[\\%_]/g, "\\$&")}%`;
    w.push(`(l.code ILIKE $${args.push(like)} OR b.name ILIKE $${args.length})`);
  }
  const { rows } = await pool.query(
    `SELECT r.id, r.status, r.created_at, r.decided_at, l.code, b.name AS broker_name, d.name AS decided_by_name, count(*) OVER()::int AS n
       FROM unit_access_requests r JOIN listings l ON l.id = r.listing_id JOIN brokers b ON b.id = r.broker_id LEFT JOIN brokers d ON d.id = r.decided_by
      WHERE ${w.join(" AND ")} AND ${Vis.units("l")} ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT $${args.push(limit)} OFFSET $${args.push(offset)}`,
    args
  );
  return { rows, total: rows[0]?.n || 0 };
}

/** Answers one request from the queue (same rules and notifications as the unit page). → { ok } | { ok: false, reason } */
async function answer(pool, actor, requestId, approve) {
  const { rows } = await pool.query(
    `SELECT l.id, l.agency_id, l.code FROM unit_access_requests r JOIN listings l ON l.id = r.listing_id WHERE r.id = $1 AND r.agency_id = $2 AND ${Vis.units("l")}`,
    [requestId, actor.agency_id]
  );
  if (!rows[0]) return { ok: false, reason: "not_found" };
  return Privacy.decide(pool, actor, rows[0], requestId, approve);
}

module.exports = { STATUSES, summary, list, answer };
