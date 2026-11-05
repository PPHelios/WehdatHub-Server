// services/linkRecipients.js — Who a unit link is sent to. The broker types a client's number or a lead reference (L-0042),
// or leaves it empty ("no recipient" is allowed). A lead the broker may see is attached to the link; a number that is a
// lead's number is attached to that lead too. Nothing else is looked up or stored.
"use strict";

const Phone = require("../domain/phone");
const Leads = require("./leads");
const Authz = require("../lib/authz");
const Vis = require("../lib/visibility");

/** → { none: true } | { phone, leadId } | { error: "invalid" | "lead_not_found" } */
async function resolveRecipient(pool, actor, text) {
  const t = String(text || "").trim().slice(0, 40);
  if (!t) return { none: true, phone: null, leadId: null };
  const ref = /^l-?(\d{1,8})$/i.exec(t);
  if (ref) {
    const lead = await Leads.getLead(pool, actor, Number(ref[1]));
    if (!lead || !lead.phone_e164) return { error: "lead_not_found" };
    return { phone: Phone.normalizePhone(lead.phone_e164), leadId: lead.id };
  }
  const phone = Phone.normalizePhone(t);
  if (!phone || !Phone.isEgyptMobile(phone)) return { error: "invalid" };
  const { rows } = await pool.query(
    `SELECT id FROM leads WHERE ${Vis.leads("leads")} AND agency_id = $1 AND (phone_e164 = $2 OR $2 = ANY(phones)) ORDER BY last_activity_at DESC NULLS LAST LIMIT 1`,
    [actor.agency_id, `+${phone}`]
  );
  let leadId = null;
  if (rows[0]) {
    const lead = await Leads.getLead(pool, actor, rows[0].id);
    if (lead && Authz.canViewLead(actor, lead)) leadId = lead.id;
  }
  return { phone, leadId };
}

module.exports = { resolveRecipient };
