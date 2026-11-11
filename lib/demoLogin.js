// lib/demoLogin.js — The demo broker for store-review sign-in. Only the demo number inside the demo agency counts, and
// only while DEMO_LOGIN_ENABLED is "true". That broker gets no login code or link sent, and no agency or role switchers.
"use strict";

const Phone = require("../domain/phone");

/** True only for the demo broker: the demo number inside the demo agency, while DEMO_LOGIN_ENABLED is "true". */
function isDemoBroker(env, broker) {
  if (String(env.DEMO_LOGIN_ENABLED || "").toLowerCase() !== "true") return false;
  if (!env.DEMO_LOGIN_PHONE || !broker) return false;
  const phone = Phone.normalizePhone(env.DEMO_LOGIN_PHONE);
  if (!phone || String(broker.phone_normalized || "") !== phone) return false;
  return String(broker.agency_id) === String(env.DEMO_LOGIN_AGENCY_ID || "").trim();
}

module.exports = { isDemoBroker };
