// services/unitRights.js — Who may add and change units. The agency owner can switch brokers' adding and editing off
// (agencies.crm_settings.brokers_edit_units = false; on by default). The switch limits plain brokers and team leads only:
// managers, the agency owner and data entry are never limited by it. Enforced where units are written
// (lib/listingStore.js createListing and applyListingPatch) and checked up front on every entry path for a clear message.
// rights() is what the app reads at sign-in to hide what a person cannot do.
"use strict";

const Authz = require("../lib/authz");
const Audit = require("./audit");
const { logOperation } = require("../lib/db");

/** A person the agency switch applies to: not a manager or the owner, and not data entry. */
const limitedByAgency = (broker) => !Authz.isManager(broker) && !Authz.isDataEntry(broker);

async function brokersMayWrite(db, agencyId) {
  const { rows } = await db.query("SELECT crm_settings->>'brokers_edit_units' AS v FROM agencies WHERE id = $1", [agencyId]);
  return rows[0]?.v !== "false";
}

/** May this person add or change units right now? */
async function mayWrite(db, broker) {
  if (!broker) return false;
  if (!limitedByAgency(broker)) return true;
  return brokersMayWrite(db, broker.agency_id);
}

/** Only the agency owner changes the switch; the change is logged. */
async function setBrokersMayWrite(pool, owner, allowed) {
  if (!Authz.isAgencyOwner(owner)) return { ok: false, reason: "not_allowed" };
  const value = allowed === true || allowed === "true" || allowed === "on" || allowed === "1";
  await Audit.recordStrict(pool, { agencyId: owner.agency_id, brokerId: owner.id, action: "brokers_edit_units", targetType: "agency", targetId: owner.agency_id, payload: { allowed: value } });
  await pool.query("UPDATE agencies SET crm_settings = crm_settings || jsonb_build_object('brokers_edit_units', $2::boolean) WHERE id = $1", [owner.agency_id, value]);
  logOperation(pool, { agency_id: owner.agency_id, broker_id: owner.id, operation_type: "brokers_edit_units", status: "success", metadata: { allowed: value } });
  return { ok: true, allowed: value };
}

/** What the app shows or hides for this person. The server still checks every action itself. */
async function rights(pool, broker) {
  const write = await mayWrite(pool, broker);
  const manager = Authz.isManager(broker);
  const dataEntry = Authz.isDataEntry(broker);
  return {
    addUnits: write,
    editUnits: write,
    leads: !dataEntry,
    search: !dataEntry,
    team: manager || Authz.isTeamLead(broker),
    // Data entry sees owners unless the agency owner switched that off (it is on by default).
    owners: manager || (dataEntry && (await require("./unitOwners").dataEntryOwnersOn(pool, broker.agency_id))),
    manager,
    agencyOwner: Authz.isAgencyOwner(broker),
    dataEntry,
    teamLead: Authz.isTeamLead(broker)
  };
}

module.exports = { limitedByAgency, brokersMayWrite, mayWrite, setBrokersMayWrite, rights };
