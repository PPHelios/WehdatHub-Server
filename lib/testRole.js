// lib/testRole.js — The test switch: one test number in the POC test agency can change its own role (owner, manager,
// broker or data entry) to see each view; the website switch changes the same row Telegram reads. Off unless
// TEST_SWITCH_PHONE and TEST_SWITCH_AGENCY_ID are both set. The CRM admin number is never switchable.
"use strict";

const Onboarding = require("./onboarding");

const ROLES = ["owner", "manager", "broker", "data_entry"];
const CRM_ADMIN_PHONE = "201055881114";

function config(env = process.env) {
  const phone = Onboarding.normalizeEgyptMobile(env.TEST_SWITCH_PHONE || "") || null;
  const agencyId = String(env.TEST_SWITCH_AGENCY_ID || "").trim() || null;
  return { phone, agencyId };
}

/** True only for the test number, inside the test agency, and never for the CRM admin number. */
function canSwitch(broker, env = process.env) {
  const c = config(env);
  if (!broker || !c.phone || !c.agencyId) return false;
  if (c.phone === CRM_ADMIN_PHONE || broker.phone_normalized === CRM_ADMIN_PHONE) return false;
  return broker.agency_id === c.agencyId && broker.phone_normalized === c.phone;
}

module.exports = { ROLES, CRM_ADMIN_PHONE, canSwitch, config };
