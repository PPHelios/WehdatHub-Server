// domain/urgency.js — Role-dynamic urgency priority ranking for SearchHome. Pure: zero database or I/O.
// Zero-count items are omitted so Today stays concise; order reflects urgency per role.
"use strict";

const URGENCY = Object.freeze({ HIGH: "high", MEDIUM: "medium", LOW: "low" });

function roleGroup(role) {
  const r = String(role || "").toLowerCase();
  if (r === "data_entry") return "data_entry";
  if (r === "owner" || r === "manager" || r === "admin") return "manager";
  if (r === "team_lead") return "team_lead";
  return "broker";
}

function item(id, urgency, count, action, extra) {
  if (!Number(count)) return null;
  const out = { id, urgency, count: Number(count), action };
  if (extra && Object.keys(extra).length) out.extra = extra;
  return out;
}

/**
 * Ranked non-zero urgency items for a viewer's home brief.
 * Deduplicates overlapping counts (e.g., waitingOver1h subsumes uncontactedOld when both exist;
 * for brokers/team leads, newLeads only shows when strictly above waitingOver1h).
 */
function buildPriorities({
  role,
  ops = null,
  overdue = 0,
  calls = 0,
  newLeads = 0,
  tomorrowViewings = 0,
  nextViewing = null,
  waitingOver1h = 0,
  intake = null,
  approvals = null,
  commissions = null,
  leasesSoon = 0,
  missingPhotos = 0,
  overdueUnitsTotal = 0
} = {}) {
  const group = roleGroup(role);
  if (group === "data_entry") {
    return [
      item("overdue-units", URGENCY.HIGH, overdueUnitsTotal, { kind: "units_old" }),
      item("missing-photos", URGENCY.LOW, missingPhotos, { kind: "units_missing_photos" })
    ].filter(Boolean);
  }

  const waitingCount = Number(waitingOver1h || 0);
  const overdueCount = Number(ops?.overdue ?? overdue ?? 0);
  const uncontactedOldCount = Number(ops?.uncontactedOld || 0);
  const viewingEntry = nextViewing?.at
    ? item("next-viewing", URGENCY.MEDIUM, 1, { kind: "lead", ref: nextViewing.ref }, {
      ref: nextViewing.ref,
      name: nextViewing.name || null,
      unitCode: nextViewing.unitCode || null,
      phone: nextViewing.phone || null,
      at: nextViewing.at
    })
    : null;

  if (group === "manager") {
    const intakeCount = Number(intake?.disconnected || 0) + Number(intake?.failed || 0);
    const commissionsCount = Number(commissions?.overdue || 0) + Number(commissions?.registrations || 0);
    return [
      item("unassigned", URGENCY.HIGH, ops?.unassigned, { kind: "queue", queue: "unassigned" }),
      waitingCount > 0
        ? item("waiting-over-1h", URGENCY.HIGH, waitingCount, { kind: "queue", queue: "waiting-over-1h" }, uncontactedOldCount > 0 ? { over24h: uncontactedOldCount } : undefined)
        : item("uncontacted-old", URGENCY.HIGH, uncontactedOldCount, { kind: "queue", queue: "delayed-first-contact" }),
      item("overdue", URGENCY.HIGH, overdueCount, { kind: "leads_tab", tab: "overdue" }),
      item("intake", URGENCY.HIGH, intakeCount, { kind: "screen", screen: "Sources" }, { disconnected: Number(intake?.disconnected || 0), failed: Number(intake?.failed || 0) }),
      item("approvals", URGENCY.MEDIUM, approvals?.access, { kind: "screen", screen: "Requests" }),
      item("owner-names", URGENCY.MEDIUM, approvals?.names, { kind: "screen", screen: "Owners" }),
      item("commissions", URGENCY.MEDIUM, commissionsCount, { kind: "screen", screen: "Commissions" }, { overdue: Number(commissions?.overdue || 0), registrations: Number(commissions?.registrations || 0) }),
      viewingEntry,
      item("calls", URGENCY.MEDIUM, calls, { kind: "leads_tab", tab: "due_today" }),
      item("leases-soon", URGENCY.LOW, leasesSoon, { kind: "screen", screen: "Leases" }),
      item("tomorrow-viewings", URGENCY.LOW, tomorrowViewings, { kind: "queue", queue: "viewings-tomorrow" }),
      item("missing-photos", URGENCY.LOW, missingPhotos, { kind: "units_missing_photos" })
    ].filter(Boolean);
  }

  // team_lead and broker: personal/team operational order without duplicating waiting-over-1h and new-leads
  const freshRemainder = Math.max(0, Number(newLeads || 0) - waitingCount);
  const firstContactRow = waitingCount > 0
    ? item("waiting-over-1h", URGENCY.HIGH, waitingCount, { kind: "queue", queue: "waiting-over-1h" })
    : null;
  const freshRow = item("new-leads", URGENCY.MEDIUM, waitingCount > 0 ? freshRemainder : newLeads, { kind: "queue", queue: "uncontacted" });

  if (group === "team_lead") {
    return [
      firstContactRow,
      item("overdue", URGENCY.HIGH, overdueCount, { kind: "leads_tab", tab: "overdue" }),
      viewingEntry,
      item("calls", URGENCY.MEDIUM, calls, { kind: "leads_tab", tab: "due_today" }),
      freshRow,
      item("tomorrow-viewings", URGENCY.LOW, tomorrowViewings, { kind: "queue", queue: "viewings-tomorrow" }),
      item("missing-photos", URGENCY.LOW, missingPhotos, { kind: "units_missing_photos" })
    ].filter(Boolean);
  }

  // broker
  return [
    item("overdue", URGENCY.HIGH, overdueCount, { kind: "leads_tab", tab: "overdue" }),
    firstContactRow,
    viewingEntry,
    item("calls", URGENCY.MEDIUM, calls, { kind: "leads_tab", tab: "due_today" }),
    freshRow,
    item("tomorrow-viewings", URGENCY.LOW, tomorrowViewings, { kind: "queue", queue: "viewings-tomorrow" }),
    item("missing-photos", URGENCY.LOW, missingPhotos, { kind: "units_missing_photos" })
  ].filter(Boolean);
}

module.exports = { URGENCY, roleGroup, buildPriorities };
