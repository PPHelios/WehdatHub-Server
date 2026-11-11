// lib/testRole.js — The test switch: one test number in the POC test agency can change its own role (owner, manager,
// broker or data entry) to see each view; the website switch changes the same row Telegram reads. It can also look at
// another agency (TEST_SWITCH_VIEW_AGENCY_ID, e.g. NCH) in read-only mode, for troubleshooting. The viewed agency is
// chosen per web session, never stored on the row, so Telegram and other users are unaffected. Off unless
// TEST_SWITCH_PHONE and TEST_SWITCH_AGENCY_ID are both set. The CRM admin number is never switchable, and neither is
// the demo broker (WebAuth.isDemoBroker), so the demo sign-in sees no switchers.
"use strict";

const Onboarding = require("./onboarding");
const WebAuth = require("./webAuth");

const ROLES = ["owner", "manager", "team_lead", "broker", "data_entry"];
const CRM_ADMIN_PHONE = "201055881114";
// Requests that stay allowed while viewing another agency: switching back, the role switch (it changes the test number's own row) and signing out.
const VIEW_OPEN = /^\/(test-view|test-role|logout)(\/|$)/;
// The one write-method request allowed while viewing: Ask answers from the viewed agency and writes nothing (services/assistant.js).
const VIEW_POST_OPEN = /^\/ask$/;

const viewing = new Map(); // web session id -> true while that session views the other agency

function config(env = process.env) {
  const phone = Onboarding.normalizeEgyptMobile(env.TEST_SWITCH_PHONE || "") || null;
  const agencyId = String(env.TEST_SWITCH_AGENCY_ID || "").trim() || null;
  const viewAgencyId = String(env.TEST_SWITCH_VIEW_AGENCY_ID || "").trim() || null;
  return { phone, agencyId, viewAgencyId };
}

/** The agency the broker really belongs to (the test agency while it views another one). */
const homeAgencyOf = (broker) => broker?.view_of || broker?.agency_id;

/** True only for the test number, inside the test agency, and never for the CRM admin number or the demo broker. */
function canSwitch(broker, env = process.env) {
  const c = config(env);
  if (!broker || !c.phone || !c.agencyId) return false;
  if (c.phone === CRM_ADMIN_PHONE || broker.phone_normalized === CRM_ADMIN_PHONE) return false;
  if (WebAuth.isDemoBroker(env, broker)) return false;
  return homeAgencyOf(broker) === c.agencyId && broker.phone_normalized === c.phone;
}

/** True when the test number may view the other agency (set, and not its own agency). */
function canView(broker, env = process.env) {
  const c = config(env);
  return Boolean(c.viewAgencyId && canSwitch(broker, env) && c.viewAgencyId !== homeAgencyOf(broker));
}

/** The broker as seen while viewing: the other agency, with the owner shown as manager (no private items). */
function asViewer(broker, env = process.env) {
  return { ...broker, view_of: homeAgencyOf(broker), home_role: broker.home_role || broker.role, agency_id: config(env).viewAgencyId, role: broker.role === "owner" ? "manager" : broker.role };
}

const setViewing = (sid, on) => {
  if (!sid) return;
  if (on) viewing.set(sid, true);
  else viewing.delete(sid);
};
const isViewing = (sid) => Boolean(sid) && viewing.has(sid);

/** True for a request that changes nothing and may run while viewing: Ask only (other non-GET requests stay refused). */
const viewPostAllowed = (method, path) => String(method || "").toUpperCase() === "POST" && VIEW_POST_OPEN.test(path || "");

module.exports = { ROLES, CRM_ADMIN_PHONE, VIEW_OPEN, viewPostAllowed, canSwitch, canView, asViewer, setViewing, isViewing, config, homeAgencyOf };
