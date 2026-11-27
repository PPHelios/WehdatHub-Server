// services/leadScope.js — Do brokers see every lead in the agency, or only their own? (Haytham, 2026-11-15)
// agencies.crm_settings.brokers_see_all_leads: absent or true = brokers see all leads of the agency (read only; working a lead
// still needs it to be theirs); false = a broker sees only the leads assigned to them (a team lead also their team's).
// The agency owner switches it in Settings; the change is audited. Managers always see every lead.
"use strict";

const Authz = require("../lib/authz");
const Audit = require("./audit");
const { logOperation } = require("../lib/db");

async function brokersSeeAll(db, agencyId) {
  const { rows } = await db.query("SELECT crm_settings->>'brokers_see_all_leads' AS v FROM agencies WHERE id = $1", [agencyId]);
  return rows[0]?.v !== "false";
}

/** True when this person may read every lead because the agency switch is on (managers need no switch). */
async function open(db, actor) {
  if (!actor || Authz.isManager(actor) || Authz.isDataEntry(actor)) return false;
  return brokersSeeAll(db, actor.agency_id);
}

async function setBrokersSeeAll(pool, owner, on) {
  if (!Authz.isAgencyOwner(owner)) return { ok: false, reason: "not_allowed" };
  const value = on === true || on === "true" || on === "on" || on === "1";
  await Audit.recordStrict(pool, { agencyId: owner.agency_id, brokerId: owner.id, action: "brokers_see_all_leads", targetType: "agency", targetId: owner.agency_id, payload: { allowed: value } });
  await pool.query("UPDATE agencies SET crm_settings = crm_settings || jsonb_build_object('brokers_see_all_leads', $2::boolean) WHERE id = $1", [owner.agency_id, value]);
  require("../lib/workspace").forget(owner.agency_id);
  logOperation(pool, { agency_id: owner.agency_id, broker_id: owner.id, operation_type: "brokers_see_all_leads", status: "success", metadata: { allowed: value } });
  return { ok: true, allowed: value };
}

module.exports = { brokersSeeAll, open, setBrokersSeeAll };
