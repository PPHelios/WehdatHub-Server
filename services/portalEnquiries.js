// services/portalEnquiries.js — Portal enquiries (Bayut, Dubizzle, Nawy). A manager or the owner forwards the portal's
// "new enquiry" message; it is kept with its name and link, and managers and the owner are told. Only managers see it.
// Adding the phone and a broker turns it into a lead through services/leads.js captureLead (the phone is the key:
// an existing lead is merged, its broker stays). The owner's switch turns the alerts off for the whole agency.
"use strict";

const Authz = require("../lib/authz");
const Vis = require("../lib/visibility");
const Notifications = require("../lib/notifications");
const Phone = require("../domain/phone");
const Leads = require("./leads");
const Parse = require("../domain/portalEnquiry");

const DUP_HOURS = 24;
const LIST_MAX = 100;

/** The unit whose portal listing number this is (visible to the viewer only), or null. */
async function unitFor(db, agencyId, listingNo) {
  if (!listingNo) return null;
  const r = await db.query(`SELECT id, code FROM listings WHERE ${Vis.units("listings")} AND agency_id = $1 AND portal_listing_no = $2 LIMIT 1`, [agencyId, listingNo]);
  return r.rows[0] || null;
}

async function alertsOn(db, agencyId) {
  const r = await db.query("SELECT portal_alerts FROM agencies WHERE id = $1", [agencyId]);
  return Boolean(r.rows[0]?.portal_alerts);
}

/**
 * Keeps a forwarded enquiry. Managers and the owner are told (one alert each, unless the owner switched them off).
 * A second enquiry with the same portal, listing and name within a day is "repeat" and is not kept twice.
 */
async function capture(pool, actor, text, { now = new Date() } = {}) {
  if (!Authz.isManager(actor)) return { outcome: "forbidden" };
  const parsed = Parse.parse(text);
  if (!parsed) return { outcome: "not_enquiry" };
  const since = new Date(now.getTime() - DUP_HOURS * 3600 * 1000);
  const dup = await pool.query(
    `SELECT id FROM portal_enquiries WHERE agency_id = $1 AND portal = $2 AND listing_no IS NOT DISTINCT FROM $3
       AND client_name IS NOT DISTINCT FROM $4 AND created_at > $5 LIMIT 1`,
    [actor.agency_id, parsed.portal, parsed.listingNo, parsed.name, since.toISOString()]
  );
  if (dup.rows[0]) return { outcome: "repeat", id: dup.rows[0].id };

  const ins = await pool.query(
    `INSERT INTO portal_enquiries (agency_id, portal, client_name, link, listing_no, created_by_broker_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`,
    [actor.agency_id, parsed.portal, parsed.name, parsed.link, parsed.listingNo, actor.id, now.toISOString()]
  );
  const enquiry = ins.rows[0];
  if (await alertsOn(pool, actor.agency_id)) {
    for (const m of await Notifications.managersOf(pool, actor.agency_id)) {
      await Notifications.notifyBroker(pool, m, {
        kind: "manager_alert",
        dedupeKey: `portal:${enquiry.id}:${m.id}`,
        title: m.preferred_lang === "en" ? `📩 New ${parsed.portal} enquiry` : `📩 استفسار جديد من ${parsed.portal}`,
        body: parsed.name || "",
        url: "/app/portal-enquiries",
        now
      });
    }
  }
  const unit = await unitFor(pool, actor.agency_id, parsed.listingNo);
  return { outcome: "created", enquiry, unit };
}

/** Lists the agency's enquiries, newest first (managers only). */
async function list(pool, actor) {
  if (!Authz.isManager(actor)) return [];
  const r = await pool.query(
    `SELECT e.*, l.code AS unit_code, b.name AS assignee_name, ld.ref AS lead_ref
       FROM portal_enquiries e
       LEFT JOIN listings l ON l.agency_id = e.agency_id AND l.portal_listing_no = e.listing_no AND ${Vis.units("l")}
       LEFT JOIN brokers b ON b.id = e.assigned_broker_id
       LEFT JOIN leads ld ON ld.id = e.lead_id
      WHERE e.agency_id = $1
      ORDER BY e.created_at DESC LIMIT ${LIST_MAX}`,
    [actor.agency_id]
  );
  return r.rows;
}

/**
 * Adds the phone and assigns a broker: the enquiry becomes a lead (source = the portal, its unit code in the notes).
 * An existing lead with that phone is merged and keeps its broker.
 */
async function assign(pool, actor, id, { phone, brokerId }) {
  if (!Authz.isManager(actor)) return { error: "forbidden" };
  const e164 = Phone.toE164(String(phone || ""));
  if (!e164) return { error: "phone_invalid" };
  const found = await pool.query("SELECT * FROM portal_enquiries WHERE id = $1 AND agency_id = $2", [id, actor.agency_id]);
  const enquiry = found.rows[0];
  if (!enquiry) return { error: "not_found" };
  if (enquiry.status === "assigned") return { error: "already_assigned" };
  const unit = await unitFor(pool, actor.agency_id, enquiry.listing_no);
  const notes = [`${enquiry.portal} enquiry: ${enquiry.link}`, unit ? `Unit: ${unit.code}` : null].filter(Boolean).join("\n");
  const res = await Leads.captureLead(pool, actor, {
    phones: [e164],
    name: enquiry.client_name,
    source: enquiry.portal,
    notes,
    assignTo: brokerId || null,
    lawfulBasis: "client_request"
  });
  if (!["created", "merged", "colleague"].includes(res.outcome)) return { error: res.outcome === "erased_before" ? "erased_before" : res.error || res.outcome };
  await pool.query(
    `UPDATE portal_enquiries SET status = 'assigned', phone_e164 = $3, lead_id = $4, assigned_broker_id = $5,
            merged = $6, updated_at = now() WHERE id = $1 AND agency_id = $2`,
    [id, actor.agency_id, e164, res.lead.id, res.lead.assigned_broker_id, res.outcome !== "created"]
  );
  const keptBroker = res.outcome !== "created" && Boolean(res.lead.assigned_broker_id) && res.lead.assigned_broker_id !== brokerId;
  return { outcome: res.outcome, leadRef: res.lead.ref, keptBroker };
}

/**
 * Links an enquiry's listing number to one of the agency's units, through the normal unit edit (the same version check,
 * permissions and price rules as any edit). The number belongs to one unit only.
 */
async function linkUnit(pool, actor, id, unitCode) {
  if (!Authz.isManager(actor)) return { error: "forbidden" };
  const found = await pool.query("SELECT listing_no FROM portal_enquiries WHERE id = $1 AND agency_id = $2", [id, actor.agency_id]);
  const listingNo = found.rows[0]?.listing_no;
  if (!listingNo) return { error: "no_listing_number" };
  const Store = require("../lib/listingStore");
  const listing = await Store.findByCode(pool, actor.agency_id, String(unitCode || "").trim());
  if (!listing) return { error: "unit_not_found" };
  if (listing.portal_listing_no === listingNo) return { outcome: "linked", code: listing.code };
  try {
    const r = await Store.applyListingPatch(pool, actor, { listing, patch: { portal_listing_no: listingNo }, expectedVersion: listing.version });
    if (r.forbidden) return { error: "forbidden" };
    if (r.conflict) return { error: "unit_changed" };
  } catch (err) {
    if (err.code === "23505") return { error: "already_linked" };
    throw err;
  }
  return { outcome: "linked", code: listing.code };
}

/** The owner's switch: alerts for the whole agency (managers and the owner). */
async function setAlerts(pool, actor, on) {
  if (!Authz.isAgencyOwner(actor)) return { error: "forbidden" };
  await pool.query("UPDATE agencies SET portal_alerts = $2 WHERE id = $1", [actor.agency_id, Boolean(on)]);
  return { outcome: "saved", on: Boolean(on) };
}

module.exports = { capture, list, assign, linkUnit, setAlerts, unitFor };
