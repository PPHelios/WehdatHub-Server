// services/activityLog.js — The agency's audit trail for people with authority: who asked for and who answered a request
// to see a unit's private details, inventory exports, and (agency owner only) role changes, the secret-details switch and
// private-portfolio changes. Read from operation_logs; kept 90 days. Managers see the data-request part; the agency owner sees all.
"use strict";

const { isManager, isAgencyOwner } = require("../lib/authz");

const KEEP_DAYS = 365;
const MANAGER_TYPES = ["secret_details_request", "secret_details_decision", "command_inventory_export"];
const OWNER_TYPES = [...MANAGER_TYPES, "secret_details_scope", "team_role_change", "portfolio_private"];
const PAGE = 50;

/**
 * Pages of 50, newest first, or null for someone who may not read the log. Optional filters: from and to (instants: the
 * "to" is exclusive) and person (the broker who asked, answered or exported).
 */
async function list(pool, viewer, { offset = 0, now = new Date(), from = null, to = null, person = null, action = null } = {}) {
  if (!isManager(viewer)) return null;
  // The agency owner sees every audited action (settings, catalogue changes, sign-ins, passkeys); a manager sees the data-request part.
  const owner = isAgencyOwner(viewer);
  const since = new Date(now.getTime() - KEEP_DAYS * 24 * 3600 * 1000).toISOString();
  const args = [viewer.agency_id, from && from > since ? from : since];
  let extra = owner ? "" : ` AND o.action = ANY($${args.push(MANAGER_TYPES)}::text[])`;
  if (to) extra += ` AND o.created_at < $${args.push(to)}`;
  if (person) extra += ` AND o.broker_id = $${args.push(person)}`;
  if (action) extra += ` AND o.action ILIKE $${args.push("%" + String(action).replace(/[%_]/g, "!$&") + "%")} ESCAPE '!'`;
  args.push(PAGE + 1, offset);
  const { rows } = await pool.query(
    `SELECT o.id, o.created_at, o.action AS operation_type, o.payload AS metadata, o.ip, o.user_agent, o.target_type, b.name AS broker_name
       FROM audit_logs o LEFT JOIN brokers b ON b.id = o.broker_id
      WHERE o.agency_id = $1 AND o.created_at >= $2${extra}
      ORDER BY o.created_at DESC, o.id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args
  );
  return { rows: rows.slice(0, PAGE), more: rows.length > PAGE };
}

/** The people the log can be filtered by (the agency's brokers). */
async function people(pool, viewer) {
  if (!isManager(viewer)) return [];
  const { rows } = await pool.query("SELECT id, name FROM brokers WHERE agency_id = $1 ORDER BY name, id", [viewer.agency_id]);
  return rows;
}

/** One readable line for a log row. */
function describe(row, lang) {
  const m = row.metadata || {};
  const L = (ar, en) => (lang === "en" ? en : ar);
  switch (row.operation_type) {
    case "secret_details_request":
      return L(`طلب يشوف البيانات الخاصة لـ ${m.code || ""}`, `Asked to see ${m.code || "a unit"}'s private details`);
    case "secret_details_decision":
      return m.approved ? L(`وافق على طلب ${m.code || ""}`, `Approved the ask for ${m.code || "a unit"}`) : L(`رفض طلب ${m.code || ""}`, `Declined the ask for ${m.code || "a unit"}`);
    case "command_inventory_export":
      return L(`نزّل الوحدات${m.rowsCount != null ? ` (${m.rowsCount})` : ""}`, `Exported the units${m.rowsCount != null ? ` (${m.rowsCount})` : ""}`);
    case "secret_details_scope":
      return L(`غيّر مين يشوف البيانات الخاصة: ${m.scope}`, `Changed who sees private details: ${m.scope}`);
    case "team_role_change":
      return L(`غيّر دور لـ ${m.role || ""}`, `Changed a role to ${m.role || ""}`);
    case "portfolio_private":
      return m.private ? L(`خلّى ${row.target_type === "lead" ? "عميل" : "وحدة"} خاص`, `Made a ${row.target_type} private`) : L(`رجّع ${row.target_type === "lead" ? "عميل" : "وحدة"} للفريق`, `Made a ${row.target_type} visible again`);
    default:
      return String(row.operation_type).replace(/^web /, "");
  }
}

module.exports = {
  people, KEEP_DAYS, PAGE, list, describe };
