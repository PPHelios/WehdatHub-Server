// services/leases.js — Rental leases and renewals. A rented unit's lease (one per unit) is added right after a rent deal closes (or from the
// unit) by whoever may edit the unit, with the tenant (a lead) and the unit's owner linked. Reminders are automatic: 3 and 2 months before the
// end (to the broker, the broker's team lead and the managers) and 30 days before each yearly increase, until someone marks the lease handled
// (renewed, leaving, re-list). The `lease_reminders` job runs hourly and sends each reminder once (leases.reminded). Everyone sees the ones
// ending soon on Today, and the Leases list. The rules are in domain/leases.js.
"use strict";

const Lz = require("../domain/leases");
const Describe = require("../domain/describe");
const Notifications = require("../lib/notifications");
const Card = require("../domain/leadCard");
const { canEdit, isManager } = require("../lib/authz");
const Vis = require("../lib/visibility");

const cairoDay = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

async function forListing(db, listing) {
  const { rows } = await db.query("SELECT * FROM leases WHERE listing_id = $1 AND agency_id = $2", [listing.id, listing.agency_id]);
  return rows[0] || null;
}

async function save(db, actor, listing, form) {
  if (!listing || listing.agency_id !== actor.agency_id || !canEdit(actor, listing)) return { error: "forbidden" };
  if (listing.listing_type !== "rent") return { error: "not_rent" };
  const f = Lz.fromForm(form);
  if (f.error) return f;
  f.remind = true; // reminders are automatic: 3 and 2 months before the end
  // F10: "L-0042" (or "L-0042 Ahmed") names one of the agency's leads; the lead's name is kept as the tenant name.
  let tenantLeadId = null;
  const ref = f.tenant_name ? Card.parseRef(f.tenant_name.split(/\s/)[0]) : null;
  if (ref) {
    const lead = (await db.query("SELECT id, name, ref FROM leads WHERE " + Vis.leads("leads") + " AND agency_id = $1 AND ref = $2", [actor.agency_id, ref])).rows[0];
    if (!lead) return { error: "bad_tenant" };
    tenantLeadId = lead.id;
    f.tenant_name = `${Card.refLabel(lead.ref)}${lead.name ? ` ${lead.name}` : ""}`.slice(0, 120);
  }
  const { rows } = await db.query(
    `INSERT INTO leases (agency_id, listing_id, broker_id, tenant_name, start_date, months, rent, increase_pct, remind, tenant_lead_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (listing_id) DO UPDATE SET broker_id = EXCLUDED.broker_id, tenant_name = EXCLUDED.tenant_name, tenant_lead_id = EXCLUDED.tenant_lead_id, start_date = EXCLUDED.start_date,
       months = EXCLUDED.months, rent = EXCLUDED.rent, increase_pct = EXCLUDED.increase_pct, remind = EXCLUDED.remind,
       reminded = CASE WHEN leases.start_date = EXCLUDED.start_date AND leases.months = EXCLUDED.months THEN leases.reminded ELSE '{}' END,
       done_at = CASE WHEN leases.start_date = EXCLUDED.start_date AND leases.months = EXCLUDED.months THEN leases.done_at ELSE NULL END,
       done_kind = CASE WHEN leases.start_date = EXCLUDED.start_date AND leases.months = EXCLUDED.months THEN leases.done_kind ELSE NULL END,
       updated_at = now()
     RETURNING *`,
    [actor.agency_id, listing.id, actor.id, f.tenant_name, f.start_date, f.months, f.rent, f.increase_pct, f.remind, tenantLeadId]
  );
  return { ok: true, lease: rows[0] };
}

/** F10: the leases where this lead is the tenant: [{ code, start_date, months, end }]. */
// Lead refs a broker can pick as a tenant: managers see the agency, brokers their own leads.
async function tenantChoices(db, broker) {
  const mgr = isManager(broker);
  const { rows } = await db.query(
    `SELECT ref, name FROM leads WHERE ${Vis.leads("leads")} AND agency_id = $1 ${mgr ? "" : "AND assigned_broker_id = $2"}
      ORDER BY (kind = 'tenant') DESC, last_activity_at DESC LIMIT 200`,
    mgr ? [broker.agency_id] : [broker.agency_id, broker.id]
  );
  return rows.map((r) => ({ label: `${Card.refLabel(r.ref)}${r.name ? ` ${r.name}` : ""}` }));
}

async function forTenant(db, agencyId, leadId) {
  const { rows } = await db.query(
    `SELECT z.*, l.code FROM leases z JOIN listings l ON l.id = z.listing_id WHERE ${Vis.units("l")} AND z.agency_id = $1 AND z.tenant_lead_id = $2 ORDER BY z.start_date DESC`,
    [agencyId, leadId]
  );
  return rows.map((r) => ({ ...r, end: Lz.endDate(r) }));
}

async function remove(db, actor, listing) {
  if (!listing || listing.agency_id !== actor.agency_id || !canEdit(actor, listing)) return { error: "forbidden" };
  await db.query("DELETE FROM leases WHERE listing_id = $1 AND agency_id = $2", [listing.id, actor.agency_id]);
  return { ok: true };
}

/** Lease ends in the next `days` days for the agency (managers): [{ code, tenant_name, end, broker_name, remind }]. */
async function upcoming(db, manager, { days = 90, now = new Date() } = {}) {
  if (!isManager(manager)) return null;
  const { rows } = await db.query(
    `SELECT z.*, l.code, b.name AS broker_name FROM leases z JOIN listings l ON l.id = z.listing_id LEFT JOIN brokers b ON b.id = z.broker_id
      WHERE ${Vis.units("l")} AND z.agency_id = $1`,
    [manager.agency_id]
  );
  const today = Date.parse(`${cairoDay(now)}T00:00:00Z`);
  return rows
    .map((r) => ({ code: r.code, tenant_name: r.tenant_name, broker_name: r.broker_name, remind: r.remind, rent: r.rent === null ? null : Number(r.rent), end: Lz.endDate(r) }))
    .filter((r) => r.end.getTime() >= today && r.end.getTime() <= today + days * 24 * 3600 * 1000)
    .sort((a, b) => a.end - b.end);
}

function reminderText(lease, r, lang) {
  const en = lang === "en";
  const date = Lz.ymd(r.date);
  if (r.kind === "end") {
    return {
      title: en ? `🏠 ${lease.code}: lease ends ${date} (${r.days} days)` : `🏠 ${lease.code}: الإيجار بيخلص ${date} (بعد ${r.days} يوم)`,
      body: en ? `${r.key === "end60" ? "No action recorded yet. " : ""}${lease.tenant_name ? `Tenant ${lease.tenant_name}. ` : ""}Open the lease to message the tenant or the owner, then mark it handled.` : `${r.key === "end60" ? "لسه مفيش إجراء متسجل. " : ""}${lease.tenant_name ? `المستأجر ${lease.tenant_name}. ` : ""}افتح العقد وابعت للمستأجر أو المالك على واتساب، وبعدين علّمه تمام.`
    };
  }
  const pct = lease.increase_pct === null ? null : Number(lease.increase_pct);
  const next = pct !== null && lease.rent !== null ? Math.round(Number(lease.rent) * Math.pow(1 + pct / 100, Number(r.key.slice(3)))) : null;
  return {
    title: en ? `📈 ${lease.code}: yearly rent increase on ${date}` : `📈 ${lease.code}: الزيادة السنوية للإيجار يوم ${date}`,
    body: pct !== null
      ? en
        ? `Increase ${pct}%${next ? `: new rent ${Describe.money(next, "en")}` : ""}. Remind the tenant and the owner.`
        : `زيادة ${pct}%${next ? `: الإيجار الجديد ${Describe.money(next, "ar")}` : ""}. فكّر المستأجر والمالك.`
      : en
        ? "Agree the new rent with the owner and the tenant."
        : "اتفق على الإيجار الجديد مع المالك والمستأجر."
  };
}

/** Who hears about a lease: its broker, that broker's team lead, and the agency's managers (all active). */
async function recipients(db, z) {
  const { rows } = await db.query(
    `SELECT id, agency_id, name, role, preferred_lang, phone_number, phone_normalized, notify_prefs, telegram_chat_id FROM brokers
      WHERE agency_id = $1 AND is_active AND (id = $2 OR lower(role) = 'manager' OR id = (SELECT team_lead_id FROM brokers WHERE id = $2))`,
    [z.agency_id, z.broker_id]
  );
  return rows;
}

/** Sends the due reminders once (to the broker, the team lead and the managers). */
async function remindDue(db, { now = new Date() } = {}) {
  const { rows } = await db.query(
    `SELECT z.*, l.code, l.status FROM leases z JOIN listings l ON l.id = z.listing_id WHERE ${Vis.units("l")} AND z.remind AND z.done_at IS NULL`
  );
  const today = cairoDay(now);
  let sent = 0;
  for (const z of rows) {
    for (const r of Lz.dueReminders(z, today)) {
      // Claim first, so two instances never send twice.
      const claim = await db.query("UPDATE leases SET reminded = array_append(reminded, $2) WHERE id = $1 AND NOT ($2 = ANY(reminded)) RETURNING id", [z.id, r.key]);
      if (!claim.rows[0]) continue;
      for (const broker of await recipients(db, z)) {
        const t = reminderText(z, r, broker.preferred_lang === "en" ? "en" : "ar");
        await Notifications.notifyBroker(db, broker, { kind: "follow_up", dedupeKey: `lease:${z.id}:${r.key}`, title: t.title, body: t.body, url: `/app/units/${encodeURIComponent(z.code)}#lease`, now, urgent: r.kind === "end" });
        sent++;
      }
    }
  }
  return { sent };
}

/** After a rent deal closes: what the "Add lease" step starts with, or null (not a rent deal, no unit, or a lease already exists). */
async function promptFor(db, actor, deal) {
  if (!deal || deal.deal_type !== "rent" || !deal.unit_code) return null;
  const listing = await require("../lib/listingStore").findByCode(db, actor.agency_id, deal.unit_code);
  if (!listing || listing.listing_type !== "rent" || !canEdit(actor, listing)) return null;
  if (await forListing(db, listing)) return null;
  return { code: listing.code, tenant: deal.lead_ref ? Card.refLabel(deal.lead_ref) : deal.client_name || null, startDate: cairoDay(deal.closed_at ? new Date(deal.closed_at) : new Date()), rent: deal.price === null || deal.price === undefined ? null : Number(deal.price) };
}

const KINDS = ["renewed", "leaving", "relist"];
/** Marks a lease handled (reminders stop): the unit's editors and managers. */
async function done(db, actor, listing, kind) {
  if (!listing || listing.agency_id !== actor.agency_id || !(canEdit(actor, listing) || isManager(actor))) return { error: "forbidden" };
  if (!KINDS.includes(kind)) return { error: "kind" };
  const r = await db.query("UPDATE leases SET done_at = now(), done_kind = $3 WHERE listing_id = $1 AND agency_id = $2 RETURNING id", [listing.id, actor.agency_id, kind]);
  return r.rows[0] ? { ok: true } : { error: "no_lease" };
}

/**
 * The leases this person tracks, soonest end first: the broker's own, a team lead's team, all for managers.
 * [{ code, tenant_name, tenant_ref, broker_name, rent, end, daysLeft, done, doneKind }]; `soon` keeps only the ones ending within 90 days and not handled.
 */
async function list(db, actor, { soon = false, now = new Date() } = {}) {
  const mgr = isManager(actor);
  const { rows } = await db.query(
    `SELECT z.*, l.code, b.name AS broker_name, ld.ref AS tenant_ref FROM leases z JOIN listings l ON l.id = z.listing_id
       LEFT JOIN brokers b ON b.id = z.broker_id LEFT JOIN leads ld ON ld.id = z.tenant_lead_id
      WHERE ${Vis.units("l")} AND z.agency_id = $1 ${mgr ? "" : "AND (z.broker_id = $2 OR b.team_lead_id = $2)"}`,
    mgr ? [actor.agency_id] : [actor.agency_id, actor.id]
  );
  const today = Date.parse(`${cairoDay(now)}T00:00:00Z`);
  const out = rows
    .map((r) => {
      const end = Lz.endDate(r);
      return { code: r.code, tenant_name: r.tenant_name, tenant_ref: r.tenant_ref ? Card.refLabel(r.tenant_ref) : null, broker_name: r.broker_name, rent: r.rent === null ? null : Number(r.rent), end, daysLeft: Math.round((end.getTime() - today) / 86400000), done: !!r.done_at, doneKind: r.done_kind || null };
    })
    .filter((r) => (soon ? !r.done && r.daysLeft >= 0 && r.daysLeft <= 90 : true))
    .sort((a, b) => a.end - b.end);
  return out;
}

/**
 * Who can be messaged about a lease, for the WhatsApp buttons: the tenant (the linked lead) and the unit's owner. The owner's
 * number follows the same secret-details rule and daily cap as the unit's contact; the lead's number follows lead visibility.
 */
async function contacts(db, actor, listing, lease) {
  const out = { tenant: null, owner: null };
  if (lease?.tenant_lead_id) {
    const { rows } = await db.query("SELECT name, ref, phone_e164 FROM leads WHERE " + Vis.leads("leads") + " AND agency_id = $1 AND id = $2" + (isManager(actor) ? "" : " AND assigned_broker_id = $3"), isManager(actor) ? [actor.agency_id, lease.tenant_lead_id] : [actor.agency_id, lease.tenant_lead_id, actor.id]);
    if (rows[0]?.phone_e164) out.tenant = { name: rows[0].name || null, ref: Card.refLabel(rows[0].ref), phone: String(rows[0].phone_e164).replace(/\D/g, "") };
  }
  const UnitPrivacy = require("./unitPrivacy");
  if (await UnitPrivacy.canSee(db, actor, listing)) {
    const Owners = require("./unitOwners");
    const ReadCaps = require("../lib/readCaps");
    const owner = listing.owner_id ? await Owners.getFor(db, actor, listing.owner_id) : null;
    const d = listing.details || {};
    const phone = owner?.phones?.[0] || d.owner_phone || null;
    if (phone && (await ReadCaps.takeOwnerPhones(db, actor, 1, { channel: "contacts", ref: listing.code })).allowed) out.owner = { name: owner?.name || d.owner_name || null, phone: String(phone).replace(/\D/g, "") };
  }
  return out;
}

function reminderJob() {
  return { name: "lease_reminders", everyMs: 60 * 60 * 1000, run: ({ pool, now }) => remindDue(pool, { now }) };
}

module.exports = { forListing, forTenant, tenantChoices, save, remove, upcoming, remindDue, reminderJob, done, list, contacts, promptFor, KINDS };
