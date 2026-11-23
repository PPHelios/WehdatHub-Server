// services/today.js — The one Today for the app and the website: the broker's tasks (services/dailyDigest.js briefData) plus
// the soon-ending leases and the cards each role needs (old units, target, ops, commissions, approvals). A card with nothing in it is null, so
// Today stays short. Everything reads behind lib/visibility; unit status is never changed here (the person edits it or uses
// the unit's own buttons).
"use strict";

const Digest = require("./dailyDigest");
const Leases = require("./leases");
const Owners = require("./unitOwners");
const Describe = require("../domain/describe");
const Vis = require("../lib/visibility");
const Stages = require("../domain/leadStages");
const Authz = require("../lib/authz");
const { refLabel } = require("../domain/leadCard");

const MAX_TASKS = 20;
const CARD_ITEMS = 5;
const OLD_AFTER_DAYS = 21; // the "Still available?" question starts here (services/unitChecks.js)
const DAY = 24 * 3600 * 1000;
const VOUCHED = "COALESCE(l.confirmed_at, l.updated_at, l.created_at)";
const digits = (p) => String(p || "").replace(/[^0-9]/g, "");

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
async function oldUnits(pool, v, ids, now, limit = CARD_ITEMS, offset = 0) {
  const args = [v.agency_id, new Date(now.getTime() - OLD_AFTER_DAYS * DAY).toISOString(), limit];
  if (ids) args.push(ids);
  const page = args.push(offset);
  const { rows } = await pool.query(
    `SELECT l.*, ${VOUCHED} AS vouched, count(*) OVER()::int AS total FROM listings l
      WHERE ${Vis.units("l")} AND l.agency_id = $1 AND l.inventory_type IS DISTINCT FROM 'developer_model'
        AND ((l.status = 'active' AND ${VOUCHED} < $2) OR (l.status = 'archived' AND l.stale_hidden_at IS NOT NULL AND l.stale_asked_at >= ${VOUCHED}))${ids ? " AND l.broker_id = ANY($4::uuid[])" : ""}
      ORDER BY ${VOUCHED}, l.code LIMIT $3 OFFSET $${page}`,
    args
  );
  if (!rows.length) return null;
  const lang = v.preferred_lang === "en" ? "en" : "ar";
  return {
    total: rows[0].total,
    items: rows.map((u) => ({ code: u.code, line: Describe.compactLine(u, lang), days: Math.floor((now.getTime() - new Date(u.vouched).getTime()) / DAY), hidden: u.status === "archived" }))
  };
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
  const [old, ops, approvals, leases] = await Promise.all([oldUnits(pool, viewer, ids, now), opsCard(pool, viewer, now), approvalsCard(pool, viewer), dataEntry ? [] : Leases.list(pool, viewer, { soon: true, now })]);
  const t = d.target;
  const com = d.commissions;
  return {
    counts: { followUpsToday: d.calls.length + d.viewings.length, viewings: d.viewings.length, newLeads: d.uncontacted },
    tasks: tasks.slice(0, MAX_TASKS),
    // Leases ending within 3 months and not yet handled (services/leases.js list); the Leases page has the rest.
    leases: leases.slice(0, 5).map((r) => ({ code: r.code, tenant: r.tenant_name, end: r.end.toISOString().slice(0, 10), daysLeft: r.daysLeft })),
    moreTasks: Math.max(0, tasks.length - MAX_TASKS),
    cards: {
      oldUnits: old,
      target: t ? { deals: t.deals, commission: t.commission, targetDeals: t.target_deals, targetCommission: t.target_commission, daysLeft: t.month.days - t.month.dayOf + 1 } : null,
      ops,
      commissions: com && (com.overdue.length || com.registrations.length) ? { overdue: com.overdue.length, registrations: com.registrations.length } : null,
      approvals
    }
  };
}

/** Just the old units card (a data entry person's Units page shows it above the list). */
async function oldUnitsFor(pool, viewer, now = new Date()) {
  return oldUnits(pool, viewer, await scopeIds(pool, viewer), now);
}

/** Search home, scoped independently of the displayed mobile role. */
async function home(pool, viewer, now = new Date()) {
  const { hour } = Digest.cairoDay(now);
  const evening = hour >= 17;
  const since = Stages.cairoDayAt(now, 0, 0).toISOString();
  const tomorrow = Stages.cairoDayAt(now, 1, 0).toISOString();
  const ids = await scopeIds(pool, viewer);
  if (Authz.isDataEntry(viewer)) {
    const [units, recent] = await Promise.all([
      oldUnits(pool, viewer, ids, now, 3),
      evening ? pool.query(
        `SELECT count(DISTINCT listing_code)::int AS n FROM operation_logs
          WHERE agency_id = $1 AND broker_id = $2 AND created_at >= $3 AND created_at < $4
            AND status = 'success' AND operation_type IN ('app_unit_edit', 'listing_confirmed', 'listing_status_active', 'listing_status_sold', 'listing_status_archived')`,
        [viewer.agency_id, viewer.id, since, tomorrow]
      ) : null
    ]);
    return { hour, units, completed: recent?.rows[0].n };
  }

  const [personal, ops, progress, nextDay] = await Promise.all([
    Digest.briefData(pool, viewer, now),
    opsCard(pool, viewer, now),
    evening ? (
      Authz.isManager(viewer)
        ? pool.query(
          `SELECT count(*)::int AS n FROM deals WHERE agency_id = $1 AND status <> 'cancelled' AND closed_at >= $2 AND closed_at < $3`,
          [viewer.agency_id, since, tomorrow]
        )
        : pool.query(
          `SELECT count(*)::int AS n FROM lead_events e JOIN leads l ON l.id = e.lead_id AND l.agency_id = e.agency_id
            WHERE ${Vis.leads("l")} AND e.agency_id = $1 AND e.broker_id = ANY($2::uuid[])
              AND e.created_at >= $3 AND e.created_at < $4 AND e.kind = 'follow_up_done' AND e.undone_at IS NULL`,
          [viewer.agency_id, ids, since, tomorrow]
        )
    ) : null,
    evening ? pool.query(
      `SELECT count(*)::int AS n FROM leads l
        WHERE ${Vis.leads("l")} AND l.agency_id = $1
          AND ($2::uuid[] IS NULL OR l.assigned_broker_id = ANY($2::uuid[]))
          AND l.stage NOT IN ('won', 'lost') AND l.follow_up_status = 'open' AND l.follow_up_kind = 'viewing'
          AND l.next_follow_up_at >= $3 AND l.next_follow_up_at < $4`,
      [viewer.agency_id, ids, tomorrow, Stages.cairoDayAt(now, 2, 0).toISOString()]
    ) : null
  ]);
  return {
    hour, ops, tomorrowViewings: nextDay?.rows[0].n, completed: progress?.rows[0].n,
    overdue: personal.overdue.length, calls: personal.calls.length, newLeads: personal.uncontacted,
    nextViewing: tasksOf({ ...personal, overdue: [] }).find((task) => task.kind === "viewing" && task.at && new Date(task.at) >= now) || null
  };
}

async function overduePage(pool, viewer, offset) {
  return await oldUnits(pool, viewer, await scopeIds(pool, viewer), new Date(), 20, offset) || { total: 0, items: [] };
}

module.exports = { build, tasksOf, oldUnitsFor, home, overduePage, OLD_AFTER_DAYS };
