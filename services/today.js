// services/today.js — The one Today for the app and the website: the broker's tasks (services/dailyDigest.js briefData) plus
// the cards each role needs (old units, target, leases, ops, commissions, approvals). A card with nothing in it is null, so
// Today stays short. Everything reads behind lib/visibility; unit status is never changed here (the person edits it or uses
// the unit's own buttons).
"use strict";

const Digest = require("./dailyDigest");
const Targets = require("./targets");
const Owners = require("./unitOwners");
const Describe = require("../domain/describe");
const Lz = require("../domain/leases");
const Vis = require("../lib/visibility");
const Authz = require("../lib/authz");
const { refLabel } = require("../domain/leadCard");

const MAX_TASKS = 20;
const CARD_ITEMS = 5;
const OLD_AFTER_DAYS = 21; // the "Still available?" question starts here (services/unitChecks.js)
const LEASE_END_DAYS = 90; // three months before the lease ends
const LEASE_INCREASE_DAYS = 30;
const DAY = 24 * 3600 * 1000;
const VOUCHED = "COALESCE(l.confirmed_at, l.updated_at, l.created_at)";
const digits = (p) => String(p || "").replace(/[^0-9]/g, "");
const cairoDay = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

function tasksOf(d) {
  const seen = new Set();
  const out = [];
  const add = (r, kind, extra = {}) => {
    if (!r || seen.has(r.ref)) return;
    seen.add(r.ref);
    out.push({ ref: refLabel(r.ref), name: r.name || null, kind, at: r.next_follow_up_at || null, unitCode: r.unit_code || null, phone: digits(r.phone_e164) || null, matches: r.n || null, ...extra });
  };
  for (const r of d.overdue) add(r, "late");
  for (const r of d.viewings) add(r, "viewing");
  for (const r of d.hot) add(r, "hot");
  for (const r of d.calls) add(r, "call");
  for (const r of d.matches) add(r, "matches");
  return out;
}

/** Who a person's cards cover: null = the agency, else the broker ids (a team lead: themselves and their team; a broker: themselves). */
async function scopeIds(pool, v) {
  if (Authz.isManager(v) || Authz.isDataEntry(v)) return null;
  if (Authz.isTeamLead(v)) {
    const { rows } = await pool.query("SELECT id FROM brokers WHERE agency_id = $1 AND team_lead_id = $2", [v.agency_id, v.id]);
    return [v.id, ...rows.map((r) => r.id)];
  }
  return [v.id];
}

/** Units nobody has confirmed for 21 days (asked or auto-hidden by the check), oldest first. */
async function oldUnits(pool, v, ids, now) {
  const args = [v.agency_id, new Date(now.getTime() - OLD_AFTER_DAYS * DAY).toISOString(), CARD_ITEMS];
  if (ids) args.push(ids);
  const { rows } = await pool.query(
    `SELECT l.*, ${VOUCHED} AS vouched, count(*) OVER()::int AS total FROM listings l
      WHERE ${Vis.units("l")} AND l.agency_id = $1 AND l.inventory_type IS DISTINCT FROM 'developer_model'
        AND ((l.status = 'active' AND ${VOUCHED} < $2) OR (l.status = 'archived' AND l.stale_hidden_at IS NOT NULL AND l.stale_asked_at >= ${VOUCHED}))${ids ? " AND l.broker_id = ANY($4::uuid[])" : ""}
      ORDER BY ${VOUCHED}, l.code LIMIT $3`,
    args
  );
  if (!rows.length) return null;
  const lang = v.preferred_lang === "en" ? "en" : "ar";
  return {
    total: rows[0].total,
    items: rows.map((u) => ({ code: u.code, line: Describe.compactLine(u, lang), days: Math.floor((now.getTime() - new Date(u.vouched).getTime()) / DAY), hidden: u.status === "archived" }))
  };
}

/** Lease ends in the next 90 days and yearly increases in the next 30, not dismissed by this person. */
async function leaseCard(pool, v, ids, now) {
  const args = [v.agency_id, v.id];
  if (ids) args.push(ids);
  const { rows } = await pool.query(
    `SELECT z.*, l.code FROM leases z JOIN listings l ON l.id = z.listing_id
      WHERE ${Vis.units("l")} AND z.agency_id = $1 AND l.status <> 'deleted'${ids ? " AND (z.broker_id = ANY($3::uuid[]) OR l.broker_id = ANY($3::uuid[]))" : ""}
        AND NOT EXISTS (SELECT 1 FROM today_dismissals d WHERE d.broker_id = $2 AND d.kind = 'lease' AND d.key = l.code || ':end:' || to_char(z.start_date + make_interval(months => z.months), 'YYYY-MM-DD'))`,
    args
  );
  const today = Date.parse(`${cairoDay(now)}T00:00:00Z`);
  const items = [];
  for (const r of rows) {
    const end = Lz.endDate(r);
    const days = Math.round((end.getTime() - today) / DAY);
    if (days >= 0 && days <= LEASE_END_DAYS) items.push({ key: `${r.code}:end:${end.toISOString().slice(0, 10)}`, code: r.code, tenant: r.tenant_name || null, kind: "end", date: end.toISOString().slice(0, 10), days });
  }
  items.sort((a, b) => a.days - b.days);
  if (!items.length) return null;
  return { total: items.length, items: items.slice(0, CARD_ITEMS) };
}

/** Leads nobody holds, nobody contacted for a day, and overdue follow-ups: the agency (manager, owner) or the team (team lead). */
async function opsCard(pool, v, now) {
  if (Authz.isDataEntry(v) || (!Authz.isManager(v) && !Authz.isTeamLead(v))) return null;
  const o = await Digest.opsFor(pool, Authz.isManager(v) ? { ...v, role: "manager" } : v, now);
  if (!o || !(o.unassigned || o.uncontactedOld || o.overdue)) return null;
  return { unassigned: o.unassigned, uncontactedOld: o.uncontactedOld, overdue: o.overdue, team: o.team };
}

/** Private-details requests and owner name changes waiting for a manager or the agency owner. */
async function approvalsCard(pool, v) {
  if (!Authz.isManager(v)) return null;
  const [{ rows }, names] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS n FROM unit_access_requests r JOIN listings l ON l.id = r.listing_id WHERE ${Vis.units("l")} AND r.agency_id = $1 AND r.status = 'pending'`,
      [v.agency_id]
    ),
    Owners.pendingFor(pool, v).catch(() => [])
  ]);
  const access = rows[0].n;
  return access || names.length ? { access, names: names.length } : null;
}

/** Today for one person: { counts, tasks, moreTasks, cards }. The app (api/today.js) and the website (web/routes/home.js) both use it. */
async function build(pool, viewer, now = new Date()) {
  const dataEntry = Authz.isDataEntry(viewer);
  const d = dataEntry
    ? { viewings: [], calls: [], overdue: [], matches: [], hot: [], uncontacted: 0, target: null, commissions: null }
    : await Digest.briefData(pool, viewer, now);
  const tasks = tasksOf(d);
  const ids = await scopeIds(pool, viewer);
  const [old, leases, ops, approvals] = await Promise.all([oldUnits(pool, viewer, ids, now), dataEntry ? null : leaseCard(pool, viewer, ids, now), opsCard(pool, viewer, now), approvalsCard(pool, viewer)]);
  const t = d.target;
  const com = d.commissions;
  return {
    counts: { followUpsToday: d.calls.length + d.viewings.length, viewings: d.viewings.length, newLeads: d.uncontacted },
    tasks: tasks.slice(0, MAX_TASKS),
    moreTasks: Math.max(0, tasks.length - MAX_TASKS),
    cards: {
      oldUnits: old,
      target: t ? { deals: t.deals, commission: t.commission, targetDeals: t.target_deals, targetCommission: t.target_commission, daysLeft: t.month.days - t.month.dayOf + 1 } : null,
      leases,
      ops,
      commissions: com && (com.overdue.length || com.registrations.length) ? { overdue: com.overdue.length, registrations: com.registrations.length } : null,
      approvals
    }
  };
}

/** A person hides a card from their own Today. */
async function dismiss(pool, viewer, kind, key) {
  if (kind !== "lease" || !/^[A-Za-z0-9._:-]{1,80}$/.test(String(key || ""))) return { error: "bad_request" };
  await pool.query("INSERT INTO today_dismissals (broker_id, kind, key) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [viewer.id, kind, key]);
  return { ok: true };
}

/** Just the old units card (a data entry person's Units page shows it above the list). */
async function oldUnitsFor(pool, viewer, now = new Date()) {
  return oldUnits(pool, viewer, await scopeIds(pool, viewer), now);
}

module.exports = { build, tasksOf, dismiss, oldUnitsFor, OLD_AFTER_DAYS, LEASE_END_DAYS };
