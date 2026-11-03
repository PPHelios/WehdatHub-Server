// lib/authz.js — Who may see or change a listing, a lead or a deal (the single copy; routes and services call this)
"use strict";

const MANAGER_ROLES = ["admin", "owner", "manager"];
/** Data entry: adds units by hand and edits any unit that is not VIP. No leads, deals, owner pages or imports. */
const DATA_ENTRY_ROLE = "data_entry";

/** Same agency is required for everything; changing a unit needs ownership or a manager role. */
function canView(broker, listing) {
  return Boolean(broker && listing && broker.agency_id && listing.agency_id === broker.agency_id);
}

function canEdit(broker, listing) {
  if (!broker || !listing) return false;
  if (listing.agency_id && listing.agency_id !== broker.agency_id) return false;
  if (MANAGER_ROLES.includes(String(broker.role || "").toLowerCase())) return true;
  if (isDataEntry(broker)) return listing.is_private !== true;
  return listing.broker_id === broker.id;
}

const isManager = (broker) => MANAGER_ROLES.includes(String(broker?.role || "").toLowerCase());
/** The agency owner: the one role above managers (plan and payments, managers, secret-details switch, deleting agency data). */
const isAgencyOwner = (broker) => String(broker?.role || "").toLowerCase() === "owner";
const sameAgency = (broker, row) => Boolean(broker && row && broker.agency_id && row.agency_id === broker.agency_id);

const isDataEntry = (broker) => String(broker?.role || "").toLowerCase() === DATA_ENTRY_ROLE;

const isTeamLead = (broker) => String(broker?.role || "").toLowerCase() === "team_lead";

/**
 * Q1: managers see every lead in the agency; a broker sees the leads assigned to them (unassigned: managers only). A team
 * lead also sees the leads assigned to a broker in their team (the lead row carries the assignee's team lead).
 */
function canViewLead(broker, lead) {
  if (!sameAgency(broker, lead)) return false;
  if (isManager(broker)) return true;
  if (!lead.assigned_broker_id) return false;
  if (lead.assigned_broker_id === broker.id) return true;
  return isTeamLead(broker) && lead.assignee_team_lead_id === broker.id;
}

/**
 * A team lead may reassign a lead they can see to a broker in their own team, or send it back to the managers (no one).
 * Managers may do anything. Returns true when the change is allowed.
 */
function canReassignLead(broker, lead, targetTeamLeadId, targetBrokerId) {
  if (!sameAgency(broker, lead)) return false;
  if (isManager(broker)) return true;
  if (!isTeamLead(broker) || !canViewLead(broker, lead)) return false;
  if (targetBrokerId === null) return true; // send back to the managers
  return targetBrokerId === broker.id || targetTeamLeadId === broker.id; // themselves, or a broker in their team
}

/** Whoever may see a lead may work it (stage, notes, follow-ups); reassigning needs canManageLeads. */
const canEditLead = (broker, lead) => canViewLead(broker, lead);

/** Assigning, reassigning, export and erase (Q9): managers only. */
const canManageLeads = (broker) => Boolean(broker?.agency_id) && isManager(broker);

/** Q10: a broker sees the deals they closed or have a share in; managers see all of the agency's deals. */
function canViewDeal(broker, deal) {
  if (!sameAgency(broker, deal) || isDataEntry(broker)) return false;
  if (isManager(broker) || deal.closing_broker_id === broker.id) return true;
  return (deal.shares || []).some((s) => s.broker_id === broker.id);
}

/** The closing broker enters the deal; a manager can correct it. */
function canEditDeal(broker, deal) {
  if (!sameAgency(broker, deal) || isDataEntry(broker)) return false;
  return isManager(broker) || deal.closing_broker_id === broker.id;
}

module.exports = { MANAGER_ROLES, DATA_ENTRY_ROLE, isManager, isAgencyOwner, isDataEntry, isTeamLead, canView, canEdit, canViewLead, canEditLead, canReassignLead, canManageLeads, canViewDeal, canEditDeal };
