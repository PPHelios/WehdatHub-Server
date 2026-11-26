// services/dashboards.js — Numbers for the agency dashboard and leaderboard (7.2, managers) and the owner's tracking
// dashboard (5.4, the product owner only). Read-only aggregate queries; the agency view never leaves its agency, and
// neither view returns a client's name or phone. Both share brokerActivity(), the per-broker figures for a period.
"use strict";

const Stages = require("../domain/leadStages");
const Discipline = require("../domain/discipline");
const { MANAGER_ROLES } = require("../lib/authz");
const { getConfig } = require("../config");
const Vis = require("../lib/visibility");

const PERIODS = [1, 7, 30, 90, 365];
const DAY = 24 * 3600 * 1000;
const { resolveInterval } = require("../domain/assistantRouter");

const isManager = (b) => MANAGER_ROLES.includes(String(b?.role || "").toLowerCase());

/** The product owner: a broker whose id is listed in OWNER_BROKER_IDS. Nobody else, managers included. */
function isOwner(broker, config = getConfig()) {
  return require("../lib/authz").isCrmOwner(broker, config);
}

const periodOf = (days) => (PERIODS.includes(Number(days)) ? Number(days) : 30);

/**
 * Per-broker figures for one agency over [since, until): leads assigned, contacted, moved forward, viewings, deals,
 * commission share (deal_splits), units added, and the median minutes from a new lead to its first contact.
 * The agency's filter is on every query.
 */
async function brokerActivity(pool, agencyId, { since, until = new Date() }) {
  const args = [agencyId, since.toISOString(), until.toISOString()];
  const { rows: brokers } = await pool.query(
    "SELECT id, name, role, is_active, (telegram_chat_id IS NOT NULL) AS telegram_linked FROM brokers WHERE agency_id = $1 ORDER BY name",
    [agencyId]
  );
  const per = new Map(
    brokers.map((b) => [
      b.id,
      {
        id: b.id,
        name: b.name,
        role: b.role,
        active: b.is_active,
        leads: 0,
        contacted: 0,
        calls: 0,
        forward: 0,
        viewings: 0,
        deals: 0,
        commission: 0,
        units: 0,
        responseMin: null,
        open: 0,
        updates: 0,
        updates48h: 0,
        activeDays: 0,
        lastUpdateAt: null,
        noNextStep: 0,
        staleOpen: 0,
        missed: 0,
        onTimePct: null,
        telegramLinked: Boolean(b.telegram_linked),
        discipline: "consistent"
      }
    ])
  );
  const put = (rows, field, key = "n") => {
    for (const r of rows) if (per.has(r.broker_id)) per.get(r.broker_id)[field] = Number(r[key]) || 0;
  };
  put(
    (await pool.query(`SELECT assigned_broker_id AS broker_id, count(*)::int AS n FROM leads WHERE ${Vis.leads("leads")} AND agency_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY 1`, args)).rows,
    "leads"
  );
  const staleCut = new Date(until.getTime() - 48 * 3600 * 1000).toISOString();
  const { rows: openRows } = await pool.query(
    `SELECT assigned_broker_id AS broker_id,
            count(*)::int AS open,
            count(*) FILTER (WHERE stage NOT IN ('new', 'won', 'lost') AND follow_up_status IS DISTINCT FROM 'open')::int AS no_next_step,
            count(*) FILTER (WHERE stage <> 'new' AND coalesce(last_activity_at, updated_at, created_at) < $2)::int AS stale_open
       FROM leads WHERE ${Vis.leads("leads")} AND agency_id = $1 AND stage NOT IN ('won', 'lost') GROUP BY 1`,
    [agencyId, staleCut]
  );
  for (const r of openRows) {
    const b = per.get(r.broker_id);
    if (!b) continue;
    b.open = Number(r.open) || 0;
    b.noNextStep = Number(r.no_next_step) || 0;
    b.staleOpen = Number(r.stale_open) || 0;
  }
  const { rows: events } = await pool.query(
    `SELECT broker_id, kind, data->>'to' AS to_stage, data->>'kind' AS fu_kind, count(*)::int AS n FROM lead_events
      WHERE agency_id = $1 AND created_at >= $2 AND created_at < $3 AND undone_at IS NULL AND kind IN ('contacted', 'stage', 'follow_up_done')
      GROUP BY 1, 2, 3, 4`,
    args
  );
  const forward = new Set(["contacted", "interested", "viewing", "negotiation", "won"]);
  for (const e of events) {
    const b = per.get(e.broker_id);
    if (!b) continue;
    if (e.kind === "contacted") {
      b.contacted += e.n;
      b.calls += e.n;
    } else if (e.kind === "follow_up_done") {
      if (e.fu_kind === "viewing") b.viewings += e.n;
      else b.calls += e.n;
    } else if (forward.has(e.to_stage)) {
      b.forward += e.n;
      if (e.to_stage === "viewing") b.viewings += e.n;
    }
  }
  const { rows: updRows } = await pool.query(
    `SELECT broker_id,
            count(*) FILTER (WHERE created_at >= $2)::int AS period_updates,
            count(*) FILTER (WHERE created_at >= $4)::int AS updates_48h,
            count(DISTINCT to_char(created_at AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD')) FILTER (WHERE created_at >= $2)::int AS active_days,
            max(created_at) AS last_update_at
       FROM lead_events
      WHERE agency_id = $1 AND broker_id IS NOT NULL AND undone_at IS NULL AND created_at < $3
        AND kind = ANY($5::text[])
      GROUP BY 1`,
    [agencyId, since.toISOString(), until.toISOString(), staleCut, Discipline.UPDATE_EVENT_KINDS]
  );
  for (const r of updRows) {
    const b = per.get(r.broker_id);
    if (!b) continue;
    b.updates = Number(r.period_updates) || 0;
    b.updates48h = Number(r.updates_48h) || 0;
    b.activeDays = Number(r.active_days) || 0;
    b.lastUpdateAt = r.last_update_at ? new Date(r.last_update_at).toISOString() : null;
  }
  put(
    (
      await pool.query(
        `SELECT s.broker_id, count(DISTINCT d.id)::int AS n, coalesce(sum(s.amount), 0)::bigint AS commission
           FROM deals d JOIN deal_splits s ON s.deal_id = d.id AND s.agency_id = d.agency_id
          WHERE d.agency_id = $1 AND d.closed_at >= $2 AND d.closed_at < $3 AND d.status <> 'cancelled' GROUP BY 1`,
        args
      )
    ).rows,
    "deals"
  );
  put(
    (
      await pool.query(
        `SELECT s.broker_id, coalesce(sum(s.amount), 0)::bigint AS commission
           FROM deals d JOIN deal_splits s ON s.deal_id = d.id AND s.agency_id = d.agency_id
          WHERE d.agency_id = $1 AND d.closed_at >= $2 AND d.closed_at < $3 AND d.status <> 'cancelled' GROUP BY 1`,
        args
      )
    ).rows,
    "commission",
    "commission"
  );
  put(
    (await pool.query(`SELECT broker_id, count(*)::int AS n FROM listings WHERE ${Vis.units("listings")} AND agency_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY 1`, args)).rows,
    "units"
  );
  // Response time: a lead's first "contacted" event (or its last_contact_at) after it arrived, per assigned broker.
  const { rows: resp } = await pool.query(
    `SELECT l.assigned_broker_id AS broker_id,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (coalesce(fc.at, l.last_contact_at) - l.created_at)) / 60) AS m
       FROM leads l
       LEFT JOIN LATERAL (SELECT min(e.created_at) AS at FROM lead_events e
                           WHERE e.lead_id = l.id AND e.agency_id = l.agency_id AND e.kind = 'contacted' AND e.undone_at IS NULL) fc ON true
      WHERE ${Vis.leads("l")} AND l.agency_id = $1 AND l.created_at >= $2 AND l.created_at < $3 AND coalesce(fc.at, l.last_contact_at) >= l.created_at
      GROUP BY 1`,
    args
  );
  for (const r of resp) if (per.has(r.broker_id) && r.m !== null) per.get(r.broker_id).responseMin = Math.round(Number(r.m));
  const sla = await require("./leadRules").speedToLead(pool, agencyId, { since, until }).catch(() => new Map());
  for (const b of per.values()) {
    const s = sla.get(b.id);
    const responded = s ? Number(s.responded) || 0 : 0;
    if (s) {
      b.missed = Number(s.missed) || 0;
      b.onTimePct = responded > 0 ? Math.round(((Number(s.on_time) || 0) * 100) / responded) : null;
    }
    b.discipline = Discipline.classifyBroker({ ...b, responded });
  }
  return [...per.values()];
}

/**
 * The agency dashboard: pipeline now, the period's totals, and the leaderboard (deals, then commission, then moves).
 * brokerId narrows it to one broker; teamLeadId to one team lead's brokers (an id that is not a team lead here gives the agency view).
 */
async function agencyDashboard(pool, manager, { days = 30, from = null, to = null, now = new Date(), brokerId = null, teamLeadId = null } = {}) {
  if (!isManager(manager)) return null;
  const workspace = manager.workspace;
  const mode = workspace?.mode || "agency";
  const { allows } = require("../domain/segments");
  const reports = { sources: !workspace || allows(workspace, "sources"), winLoss: !workspace || allows(workspace, "winLoss") };
  if (mode === "solo") {
    brokerId = null;
    teamLeadId = null;
  }
  const period = periodOf(days);
  const interval = (from || to)
    ? resolveInterval({ from, to, days: period, now, maxDays: 366 })
    : period === 1
      ? { since: new Date(Stages.cairoDayAt(now, 0, 0)), until: now }
      : { since: new Date(now.getTime() - period * DAY), until: now };
  const since = interval.since;
  const until = interval.until;
  const agencyId = manager.agency_id;
  const team = await pool.query("SELECT id, name FROM brokers WHERE agency_id = $1 AND is_active ORDER BY name", [agencyId]);
  const who = team.rows.some((b) => b.id === brokerId) ? brokerId : null; // an id from another agency is ignored
  // A team lead's view: the brokers whose team lead is this one (an id from another agency or not a team lead gives nothing).
  let lead = null;
  if (teamLeadId && !who && /^[0-9a-f-]{36}$/i.test(String(teamLeadId))) {
    const { rows } = await pool.query("SELECT id, name FROM brokers WHERE agency_id = $1 AND id = $2 AND lower(role) = 'team_lead'", [agencyId, teamLeadId]);
    lead = rows[0] || null; // not a team lead here: the agency view
  }
  const ids = who ? [who] : lead ? (await pool.query("SELECT id FROM brokers WHERE agency_id = $1 AND team_lead_id = $2", [agencyId, lead.id])).rows.map((r) => r.id) : null;
  // " AND col = ANY(ids)" when a broker or a team is picked; the agency view has no filter. Pushes ids onto the query's params.
  const scope = (col, params) => (ids ? ` AND ${col} = ANY($${params.push(ids)}::uuid[])` : "");
  const a = [agencyId];
  const { rows: stageRows } = await pool.query(`SELECT stage, count(*)::int AS n FROM leads WHERE ${Vis.leads("leads")} AND agency_id = $1${scope("assigned_broker_id", a)} GROUP BY stage`, a);
  const pipeline = Object.fromEntries(Stages.STAGES.map((s) => [s, 0]));
  for (const r of stageRows) pipeline[r.stage] = r.n;
  const ua = [agencyId, now.toISOString(), new Date(now.getTime() - 3600 * 1000).toISOString()];
  const uScope = ids ? ` AND assigned_broker_id = ANY($${ua.push(ids)}::uuid[])` : "";
  const { rows: un } = await pool.query(
    `SELECT count(*) FILTER (WHERE assigned_broker_id IS NULL AND stage NOT IN ('won', 'lost'))::int AS unassigned,
            count(*) FILTER (WHERE stage = 'new' AND last_contact_at IS NULL${uScope})::int AS uncontacted,
            count(*) FILTER (WHERE assigned_broker_id IS NOT NULL AND stage = 'new' AND last_contact_at IS NULL AND created_at < $3${uScope})::int AS "waitingOver1h",
            count(*) FILTER (WHERE follow_up_status = 'open' AND next_follow_up_at < $2${uScope})::int AS overdue
       FROM leads WHERE ${Vis.leads("leads")} AND agency_id = $1`,
    ua
  );
  const us = [agencyId, new Date(now.getTime() - 21 * DAY).toISOString()];
  const vouched = "coalesce(confirmed_at, updated_at, created_at)";
  const { rows: units } = await pool.query(
    `SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
            count(*) FILTER (WHERE inventory_type IS DISTINCT FROM 'developer_model'
              AND ((status = 'active' AND ${vouched} < $2)
                OR (status = 'archived' AND stale_hidden_at IS NOT NULL AND stale_asked_at >= ${vouched})))::int AS stale
       FROM listings WHERE ${Vis.units("listings")} AND agency_id = $1${scope("broker_id", us)}`,
    us
  );
  const { rows: teamLeads } = await pool.query("SELECT id, name FROM brokers WHERE agency_id = $1 AND is_active AND lower(role) = 'team_lead' ORDER BY name", [agencyId]);
  const ds = [agencyId, since.toISOString(), until.toISOString()];
  const { rows: dealRows } = await pool.query(
    `SELECT count(*)::int AS n, coalesce(sum(commission_total), 0)::bigint AS commission, coalesce(sum(price), 0)::bigint AS value
       FROM deals WHERE agency_id = $1 AND closed_at >= $2 AND closed_at < $3 AND status <> 'cancelled'${scope("closing_broker_id", ds)}`,
    ds
  );
  const brokers = (await brokerActivity(pool, agencyId, { since, until })).filter((b) => !ids || ids.includes(b.id));
  const board = brokers
    .filter((b) => b.active || b.deals || b.leads)
    .sort((a, b) => b.deals - a.deals || b.commission - a.commission || b.forward - a.forward || b.contacted - a.contacted || a.name.localeCompare(b.name));
  // Headline new leads counts agency-wide leads (including unassigned leads, while broker/team scopes narrow it).
  const la = [agencyId, since.toISOString(), until.toISOString()];
  const { rows: leadRows } = await pool.query(
    `SELECT count(*)::int AS n FROM leads WHERE ${Vis.leads("leads")} AND agency_id = $1 AND created_at >= $2 AND created_at < $3${scope("assigned_broker_id", la)}`,
    la
  );
  const leads = leadRows[0].n;
  // New leads per week (last 8 weeks, oldest first) and the period's top sources, for the bars on the page.
  const weekStart = new Date(now.getTime() - 8 * 7 * DAY);
  const wa = [agencyId, now.toISOString(), weekStart.toISOString()];
  const { rows: wk } = await pool.query(
    `SELECT floor(extract(epoch FROM ($2::timestamptz - created_at)) / 604800)::int AS ago, count(*)::int AS n
       FROM leads WHERE ${Vis.leads("leads")} AND agency_id = $1 AND created_at >= $3${scope("assigned_broker_id", wa)} GROUP BY 1`,
    wa
  );
  const weekly = Array.from({ length: 8 }, (_, i) => wk.find((r) => r.ago === 7 - i)?.n || 0);
  const fmtCairoMd = (d) => {
    const ymd = Stages.cairoDay(d);
    return `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}`;
  };
  const weeklyRanges = Array.from({ length: 8 }, (_, i) => {
    const ago = 7 - i;
    const start = new Date(now.getTime() - (ago + 1) * 7 * DAY);
    const end = new Date(now.getTime() - ago * 7 * DAY);
    return { from: Stages.cairoDay(start), to: Stages.cairoDay(end), label: `${fmtCairoMd(start)}–${fmtCairoMd(end)}` };
  });
  const sa = [agencyId, since.toISOString()];
  const { rows: sources } = await pool.query(
    `SELECT coalesce(nullif(source, ''), '-') AS source, count(*)::int AS n
       FROM leads WHERE ${Vis.leads("leads")} AND agency_id = $1 AND created_at >= $2${scope("assigned_broker_id", sa)}
      GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 3`,
    sa
  );
  const Intake = require("./leadIntake");
  const channels = reports.sources ? await Intake.listForAgency(pool, agencyId).catch(() => []) : [];
  const intake = channels.reduce((acc, ch) => {
    if (ch.revoked_at) return acc;
    if (ch.status === "disconnected") acc.disconnected += 1;
    acc.failed += Number(ch.failed_30 || 0);
    return acc;
  }, { disconnected: 0, failed: 0 });
  const disciplineSummary = Discipline.summarizeBoard(mode === "solo" ? [] : board);
  return {
    mode,
    reports,
    intake,
    disciplineSummary,
    days: period,
    weekly,
    weeklyRanges,
    unassignedScope: "agency",
    sources: reports.sources ? sources : [],
    team: mode === "solo" ? [] : team.rows,
    brokerId: who,
    teamLeads: mode === "solo" ? [] : teamLeads,
    teamLeadId: lead ? lead.id : null,
    teamName: lead ? lead.name : null,
    pipeline,
    ...un[0],
    units: units[0],
    deals: { n: dealRows[0].n, commission: Number(dealRows[0].commission), value: Number(dealRows[0].value) },
    leads,
    board: mode === "solo" ? [] : board
  };
}

/** Monday 00:00 Cairo of the week containing `at`. */
function weekStart(at) {
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", weekday: "short" }).format(at));
  return Stages.cairoDayAt(at, -dow, 0);
}

/**
 * The owner's dashboard: weekly active agencies and brokers (anyone who used the bot or the website), units, leads and
 * deals created per week; AI calls and cost per agency for the last 30 days; errors and bug reports. Owner only.
 */
async function ownerDashboard(pool, broker, { weeks = 8, now = new Date(), config = getConfig() } = {}) {
  if (!isOwner(broker, config)) return null;
  const first = new Date(weekStart(now).getTime() - (weeks - 1) * 7 * DAY);
  // The week as text ("2026-11-09"): a timestamp without a zone would be read in the server's own time zone and miss the week it belongs to.
  const bucket = (col) => `to_char(date_trunc('week', (${col}) AT TIME ZONE 'Africa/Cairo'), 'YYYY-MM-DD')`;
  const weekly = async (sql) => (await pool.query(sql, [first.toISOString()])).rows;
  const activity = await weekly(
    `SELECT ${bucket("created_at")} AS week, count(DISTINCT agency_id)::int AS agencies, count(DISTINCT broker_id)::int AS brokers
       FROM operation_logs WHERE created_at >= $1 AND broker_id IS NOT NULL GROUP BY 1`
  );
  const created = async (table, col = "created_at", extra = "") => weekly(`SELECT ${bucket(col)} AS week, count(*)::int AS n FROM ${table} WHERE ${col} >= $1 ${extra} GROUP BY 1`);
  const units = await created("listings");
  const leads = await created("leads");
  const deals = await created("deals", "created_at", "AND status <> 'cancelled'");
  const errors = await weekly(
    `SELECT ${bucket("created_at")} AS week, count(*) FILTER (WHERE kind = 'error')::int AS errors, count(*) FILTER (WHERE kind = 'report')::int AS reports
       FROM error_events WHERE created_at >= $1 GROUP BY 1`
  );
  const key = (d) => new Date(d).toISOString().slice(0, 10);
  const rows = [];
  for (let i = 0; i < weeks; i++) {
    const start = new Date(first.getTime() + i * 7 * DAY);
    rows.push({ week: Stages.toCairoLocal(start).slice(0, 10), agencies: 0, brokers: 0, units: 0, leads: 0, deals: 0, errors: 0, reports: 0 });
  }
  const byWeek = new Map(rows.map((r) => [r.week, r]));
  const fill = (list, fields) => {
    for (const r of list) {
      const row = byWeek.get(key(r.week));
      if (row) for (const [from, to] of fields) row[to] = Number(r[from]) || 0;
    }
  };
  fill(activity, [["agencies", "agencies"], ["brokers", "brokers"]]);
  fill(units, [["n", "units"]]);
  fill(leads, [["n", "leads"]]);
  fill(deals, [["n", "deals"]]);
  fill(errors, [["errors", "errors"], ["reports", "reports"]]);

  const since30 = new Date(now.getTime() - 30 * DAY).toISOString();
  const { rows: ai } = await pool.query(
    `SELECT a.id, a.name, count(o.*)::int AS calls, count(o.*) FILTER (WHERE o.status = 'failed')::int AS failed,
            coalesce(sum(o.estimated_cost_usd), 0)::float AS usd
       FROM agencies a LEFT JOIN operation_logs o ON o.agency_id = a.id AND o.created_at >= $1 AND o.model_used IS NOT NULL
      GROUP BY a.id, a.name ORDER BY usd DESC, a.name`,
    [since30]
  );
  const { rows: people } = await pool.query(
    `SELECT a.id, count(b.*) FILTER (WHERE b.is_active)::int AS brokers,
            count(b.*) FILTER (WHERE b.is_active AND b.telegram_chat_id IS NOT NULL)::int AS telegram,
            max(b.last_active_at) AS last_active
       FROM agencies a LEFT JOIN brokers b ON b.agency_id = a.id GROUP BY a.id`
  );
  const peopleBy = new Map(people.map((p) => [p.id, p]));
  const agencies = ai.map((a) => ({ ...a, usd: Number(a.usd), ...(peopleBy.get(a.id) ? { brokers: peopleBy.get(a.id).brokers, telegram: peopleBy.get(a.id).telegram, lastActive: peopleBy.get(a.id).last_active } : {}) }));
  const { rows: topErrors } = await pool.query(
    `SELECT fingerprint, kind, source, max(message) AS message, count(*)::int AS n, max(created_at) AS last, max(id) AS last_id
       FROM error_events WHERE created_at >= $1 AND resolved_at IS NULL GROUP BY fingerprint, kind, source ORDER BY n DESC, last DESC LIMIT 10`,
    [new Date(now.getTime() - 7 * DAY).toISOString()]
  );
  // The log the owner reads to understand a failure: the latest errors and reports with their time, place and stack
  // (the stack and message are masked when stored, lib/errorReports.js).
  const { rows: recentErrors } = await pool.query(
    `SELECT e.id, e.kind, e.source, e.message, left(e.stack, 3000) AS stack, e.path, e.created_at, e.agency_id, e.broker_id, e.resolved_at,
            (SELECT count(*)::int FROM error_events x WHERE x.fingerprint = e.fingerprint AND x.created_at >= $1) AS n
       FROM error_events e WHERE e.created_at >= $1 ORDER BY e.created_at DESC, e.id DESC LIMIT 50`,
    [new Date(now.getTime() - 7 * DAY).toISOString()]
  );
  const { rows: jobs } = await pool.query("SELECT name, last_status, last_finished_at, last_error FROM crm_jobs ORDER BY name");
  const delivery = await deliveryHealth(pool, now);
  const { rows: trials } = await pool.query("SELECT id, name, agency_name, phone_e164, team_size, created_at FROM demo_requests WHERE kind = 'trial' ORDER BY created_at DESC LIMIT 20");
  const { rows: demos } = await pool.query(
    "SELECT id, name, agency_name, phone_e164, team_size, created_at, pilot_agency_id FROM demo_requests WHERE kind = 'demo' ORDER BY created_at DESC LIMIT 30"
  );
  return { weeks: rows, agencies, topErrors, recentErrors, jobs, delivery, trials, demos, totalUsd: agencies.reduce((s, a) => s + a.usd, 0) };
}

/**
 * How notifications are going out (owner board): the last 7 Cairo days by status, the last 24 hours by channel, today's
 * morning brief and evening digest, what is waiting or stuck now, and the latest failures. Counts and error codes only:
 * no titles, names or client data.
 */
async function deliveryHealth(pool, now = new Date()) {
  const day = "to_char(created_at AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD')";
  const since7 = new Date(now.getTime() - 7 * DAY).toISOString();
  const since1 = new Date(now.getTime() - DAY).toISOString();
  const [days, channels, daily, now_, failures] = await Promise.all([
    pool.query(
      `SELECT ${day} AS day, count(*) FILTER (WHERE status = 'sent')::int AS sent, count(*) FILTER (WHERE status = 'failed')::int AS failed,
              count(*) FILTER (WHERE status = 'skipped')::int AS skipped, count(*) FILTER (WHERE attempts > 1 AND status = 'sent')::int AS retried_ok
         FROM notifications WHERE created_at >= $1 GROUP BY 1 ORDER BY 1 DESC`,
      [since7]
    ),
    pool.query(`SELECT coalesce(channel, '—') AS channel, count(*)::int AS n FROM notifications WHERE created_at >= $1 AND status = 'sent' GROUP BY 1 ORDER BY n DESC`, [since1]),
    pool.query(
      `SELECT kind, count(*) FILTER (WHERE status = 'sent')::int AS sent, count(*) FILTER (WHERE status = 'failed')::int AS failed,
              count(*) FILTER (WHERE status = 'skipped')::int AS skipped, count(*) FILTER (WHERE status IN ('pending', 'queued', 'held'))::int AS waiting
         FROM notifications WHERE kind IN ('daily_brief', 'daily_digest') AND ${day} = to_char($1::timestamptz AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD') GROUP BY kind ORDER BY kind`,
      [now.toISOString()]
    ),
    pool.query(
      `SELECT count(*) FILTER (WHERE status = 'queued' AND reason = 'retry')::int AS retrying,
              count(*) FILTER (WHERE (status = 'pending' AND created_at < $1) OR (status IN ('held', 'queued') AND deliver_after < $2))::int AS stuck
         FROM notifications WHERE created_at >= $3`,
      [new Date(now.getTime() - 15 * 60000).toISOString(), new Date(now.getTime() - 30 * 60000).toISOString(), since7]
    ),
    pool.query(
      `SELECT kind, coalesce(last_error, '—') AS error, attempts, created_at FROM notifications WHERE status = 'failed' AND created_at >= $1 ORDER BY created_at DESC, id DESC LIMIT 10`,
      [since7]
    )
  ]);
  return { days: days.rows, channels: channels.rows, daily: daily.rows, retrying: now_.rows[0].retrying, stuck: now_.rows[0].stuck, failures: failures.rows };
}

/** The app in one period (owner only): active agencies and brokers, new units, leads, deals, errors and reports; and the period before. */
async function ownerPeriod(pool, broker, p, config = getConfig()) {
  if (!isOwner(broker, config)) return null;
  const one = async (from, to) => {
    const args = [from, to];
    const n = async (sql) => (await pool.query(sql, args)).rows[0];
    const [act, units, leads, deals, errs] = await Promise.all([
      n("SELECT count(DISTINCT agency_id)::int AS agencies, count(DISTINCT broker_id)::int AS brokers FROM operation_logs WHERE created_at >= $1 AND created_at < $2 AND broker_id IS NOT NULL"),
      n(`SELECT count(*)::int AS n FROM listings WHERE created_at >= $1 AND created_at < $2 AND ${Vis.units("listings")}`),
      n(`SELECT count(*)::int AS n FROM leads WHERE created_at >= $1 AND created_at < $2 AND ${Vis.leads("leads")}`),
      n("SELECT count(*)::int AS n FROM deals WHERE created_at >= $1 AND created_at < $2 AND status <> 'cancelled'"),
      n("SELECT count(*) FILTER (WHERE kind = 'error')::int AS errors, count(*) FILTER (WHERE kind = 'report')::int AS reports FROM error_events WHERE created_at >= $1 AND created_at < $2")
    ]);
    return { agencies: act.agencies, brokers: act.brokers, units: units.n, leads: leads.n, deals: deals.n, errors: errs.errors, reports: errs.reports };
  };
  const [now, before] = await Promise.all([one(p.from, p.to), one(p.prevFrom, p.prevTo)]);
  return { now, before };
}

module.exports = { deliveryHealth, ownerPeriod, PERIODS, isOwner, isManager, brokerActivity, agencyDashboard, ownerDashboard, weekStart };
