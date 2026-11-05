// services/openedLinks.js — "Opened links" (/app/links): every unit link sent to a client, with who sent it, when, to whom (the
// lead, when it was sent to one) and how often it was opened. Scope by role: a broker sees their own links; a team lead
// sees theirs and their team's; a manager and the owner see every link of the agency. Data entry sees none. Private units
// follow the unit rule (lib/visibility.js); a lead's name and number show only to whoever may see that lead.
"use strict";

const Authz = require("../lib/authz");
const Vis = require("../lib/visibility");
const Phone = require("../domain/phone");

const PAGE = 20;
const UUID = /^[0-9a-f-]{36}$/i;
const STATUSES = ["all", "never", "opened", "repeat", "recent"];
const CHANNELS = ["all", "whatsapp", "web"];
const SOURCES = ["all", "bot", "web", "lead"];

/** Builds the WHERE list and its parameters. Each condition takes its own values, so placeholders stay in step. */
function conditions(viewer, f, now) {
  const args = [viewer.agency_id];
  const where = ["s.agency_id = $1", "s.revoked_at IS NULL", "s.expires_at > ?"];
  const put = (sql, values) => {
    where.push(sql.replace(/\?/g, () => `$${args.push(values.shift())}`));
  };
  // The expiry first: its placeholder is the current time.
  where[2] = `s.expires_at > $${args.push(now.toISOString())}`;

  if (Authz.isDataEntry(viewer)) return { where: ["FALSE"], args };
  if (Authz.isTeamLead(viewer) && !Authz.isManager(viewer)) {
    put("(s.broker_id = ? OR sb.team_lead_id = ?)", [viewer.id, viewer.id]);
  } else if (!Authz.isManager(viewer)) {
    put("s.broker_id = ?", [viewer.id]);
  } else {
    if (f.broker && UUID.test(f.broker)) put("s.broker_id = ?", [f.broker]);
    if (f.team && UUID.test(f.team)) put("(sb.team_lead_id = ? OR s.broker_id = ?)", [f.team, f.team]);
  }

  if (f.channel === "whatsapp" || f.channel === "web") put("s.channel = ?", [f.channel]);
  if (f.source === "bot" || f.source === "web" || f.source === "lead") put("s.source = ?", [f.source]);
  if (f.status === "never") where.push("s.open_count = 0");
  if (f.status === "opened") where.push("s.open_count > 0");
  if (f.status === "repeat") where.push("s.open_count >= 2");
  if (f.status === "recent") put("s.last_opened_at > ?", [new Date(now.getTime() - 48 * 3600 * 1000).toISOString()]);

  const q = String(f.q || "").trim().slice(0, 60);
  if (q) {
    const digits = Phone.toAsciiDigits(q).replace(/\D/g, "").replace(/^0+/, "");
    if (digits.length >= 4 && /^[\d\s+\-().٠-٩]+$/.test(q)) {
      put("(s.recipient_phone LIKE '%' || ? || '%' OR EXISTS (SELECT 1 FROM unnest(ld.phones) p WHERE p LIKE '%' || ? || '%'))", [digits, digits]);
    } else {
      const ref = /^l-?(\d{1,8})$/i.exec(q);
      const like = q.replace(/[%_\\]/g, (c) => `\\${c}`);
      if (ref) put("(ld.ref = ? OR l.code ILIKE '%' || ? || '%')", [Number(ref[1]), like]);
      else put("(l.code ILIKE '%' || ? || '%' OR ld.name ILIKE '%' || ? || '%')", [like, like]);
    }
  }
  return { where, args };
}

/**
 * One page of links for the viewer, with the filters applied.
 * f: { q, status, channel, broker, team, page } — broker and team are broker ids (managers and the owner only).
 * @returns {Promise<{ rows, total, pages, page }>}
 */
async function list(pool, viewer, f = {}, { now = new Date() } = {}) {
  if (Authz.isDataEntry(viewer)) return { rows: [], total: 0, pages: 1, page: 0 };
  const { where, args } = conditions(viewer, f, now);
  const from = `FROM share_links s
    JOIN listings l ON l.id = s.listing_id AND l.agency_id = s.agency_id
    LEFT JOIN brokers sb ON sb.id = s.broker_id
    LEFT JOIN leads ld ON ld.id = s.lead_id AND ${Vis.leads("ld")}`;
  const cond = `${Vis.units("l")} AND ${where.join(" AND ")}`;
  const { rows: count } = await pool.query(`SELECT count(*)::int AS n ${from} WHERE ${cond}`, args);
  const total = count[0].n;
  const pageNo = Math.max(0, Math.min(parseInt(f.page, 10) || 0, 10000));
  const { rows } = await pool.query(
    `SELECT s.token_hash, s.channel, s.created_at, s.open_count, s.first_opened_at, s.last_opened_at, s.lead_id,
            s.recipient_phone, s.source, s.note,
            (SELECT count(DISTINCT o.visitor)::int FROM share_link_opens o WHERE o.token_hash = s.token_hash) AS devices,
            l.code AS unit_code, l.property_type, l.compound, sb.name AS sent_by, sb.team_lead_id AS sent_by_team_lead,
            ld.ref AS lead_ref, ld.name AS lead_name, ld.phone_e164 AS lead_phone, ld.assigned_broker_id
       ${from} WHERE ${cond}
       ORDER BY s.last_opened_at DESC NULLS LAST, s.created_at DESC
       LIMIT ${PAGE} OFFSET ${pageNo * PAGE}`,
    args
  );
  const shown = [];
  for (const r of rows) shown.push(await withLeadRights(pool, viewer, r));
  return { rows: shown, total, pages: Math.max(1, Math.ceil(total / PAGE)), page: pageNo };
}

/** A lead's name and number are shown only to whoever may see that lead (lib/authz.js canViewLead). */
async function withLeadRights(pool, viewer, r) {
  if (!r.lead_id) return { ...r, lead: null };
  let teamLead = null;
  if (r.assigned_broker_id) {
    const { rows } = await pool.query("SELECT team_lead_id FROM brokers WHERE id = $1", [r.assigned_broker_id]);
    teamLead = rows[0]?.team_lead_id || null;
  }
  const lead = { agency_id: viewer.agency_id, assigned_broker_id: r.assigned_broker_id, assignee_team_lead_id: teamLead };
  if (!Authz.canViewLead(viewer, lead)) return { ...r, lead: { ref: r.lead_ref, name: null, phone: null, hidden: true } };
  return { ...r, lead: { ref: r.lead_ref, name: r.lead_name, phone: r.lead_phone, hidden: false } };
}

/**
 * The short summary the bot's "links" command shows: how many of the viewer's links (same scope as the page) were sent in
 * the last 7 days, opened in the last 48 hours, never opened after 2 days, and opened more than once.
 */
async function summary(pool, viewer, { now = new Date() } = {}) {
  if (Authz.isDataEntry(viewer)) return { sent7: 0, opened48: 0, never: 0, repeat: 0, total: 0 };
  const { where, args } = conditions(viewer, {}, now);
  const t7 = args.push(new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString());
  const t48 = args.push(new Date(now.getTime() - 48 * 3600 * 1000).toISOString());
  const t2d = args.push(new Date(now.getTime() - 2 * 24 * 3600 * 1000).toISOString());
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE s.created_at > $${t7})::int AS sent7,
            count(*) FILTER (WHERE s.last_opened_at > $${t48})::int AS opened48,
            count(*) FILTER (WHERE s.open_count = 0 AND s.created_at < $${t2d})::int AS never,
            count(*) FILTER (WHERE s.open_count >= 2)::int AS repeat,
            count(*)::int AS total
       FROM share_links s
       JOIN listings l ON l.id = s.listing_id AND l.agency_id = s.agency_id
       LEFT JOIN brokers sb ON sb.id = s.broker_id
       LEFT JOIN leads ld ON ld.id = s.lead_id AND ${Vis.leads("ld")}
      WHERE ${Vis.units("l")} AND ${where.join(" AND ")}`,
    args
  );
  return rows[0];
}

module.exports = { PAGE, STATUSES, CHANNELS, SOURCES, conditions, list, withLeadRights, summary };
