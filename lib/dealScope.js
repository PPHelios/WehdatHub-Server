// lib/dealScope.js — Which brokers a deal or commission list covers, and the SQL that narrows a query to them.
//  - A manager sees the whole agency, and may narrow it to one broker or to a team (a team lead and the brokers under them).
//  - A team lead sees their own team (themselves and the brokers under them), and may narrow it to one of those brokers.
//  - Anyone else sees the deals they closed or share in, and only their own share.
"use strict";

const { isManager, isTeamLead } = require("./authz");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v) => UUID_RE.test(String(v || ""));

/** The brokers of a team: its lead and the brokers under them (inactive ones too, so past deals still count). */
async function teamIds(db, agencyId, leadId) {
  const { rows } = await db.query("SELECT id FROM brokers WHERE agency_id = $1 AND (id = $2 OR team_lead_id = $2)", [agencyId, leadId]);
  return rows.map((r) => r.id);
}

/**
 * @returns {Promise<null | string[]>} the broker ids in scope; null means the whole agency (a manager with no filter).
 */
async function scopeIds(db, actor, { brokerId = null, teamLeadId = null } = {}) {
  if (isManager(actor)) {
    if (isId(brokerId)) return [brokerId];
    if (isId(teamLeadId)) return teamIds(db, actor.agency_id, teamLeadId);
    return null;
  }
  if (isTeamLead(actor)) {
    const team = await teamIds(db, actor.agency_id, actor.id);
    return isId(brokerId) && team.includes(brokerId) ? [brokerId] : team;
  }
  return [actor.id];
}

/** SQL: the deal (alias d) was closed by, or shares with, one of the brokers in $n. */
const inScopeSql = (n) =>
  `(d.closing_broker_id = ANY($${n}::uuid[]) OR EXISTS (SELECT 1 FROM deal_splits sc WHERE sc.deal_id = d.id AND sc.broker_id = ANY($${n}::uuid[])))`;

/** SQL: the amount a list shows: the whole commission (no scope), else the shares of the brokers in $n. */
const scopeAmountSql = (n) =>
  `(CASE WHEN $${n}::uuid[] IS NULL THEN d.commission_total ELSE (SELECT COALESCE(SUM(sa.amount), 0) FROM deal_splits sa WHERE sa.deal_id = d.id AND sa.broker_id = ANY($${n}::uuid[])) END)`;

module.exports = { scopeIds, teamIds, inScopeSql, scopeAmountSql, isId };
