// services/team.js — Managers run their team from the website (5.5): invite a broker (name, mobile, role) and hand them
// a one-time Telegram start link (lib/tgLink.js, 7 days), issue a fresh link to someone not linked yet, deactivate or
// bring back a broker. Every action is the manager's own agency only; a mobile registered with another agency is
// refused, never moved. Admin and owner roles stay with onboarding (npm run onboard).
"use strict";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const Phone = require("../domain/phone");
const TgLink = require("../lib/tgLink");
const Brokers = require("./brokers");
const Billing = require("./billing");
const { MANAGER_ROLES, isAgencyOwner } = require("../lib/authz");
const { getConfig } = require("../config");
const forgetWorkspace = (agencyId) => require("../lib/workspace").forget(agencyId);

const INVITE_ROLES = ["broker", "manager", "data_entry"];
/** Roles a manager can add a member as (a team lead too; changeRole keeps INVITE_ROLES: a team lead is made through setTeamLeadRole). */
const ADD_ROLES = [...INVITE_ROLES, "team_lead"];
const isManager = (b) => MANAGER_ROLES.includes(String(b?.role || "").toLowerCase());
const TOP_ROLES = ["admin", "owner"];
/** A manager may act on brokers and managers; only an admin or owner may act on an admin or owner. */
const mayActOn = (actor, targetRole) =>
  !TOP_ROLES.includes(String(targetRole || "").toLowerCase()) || TOP_ROLES.includes(String(actor?.role || "").toLowerCase());

/** The agency's brokers with what the team page shows (no client data): active by name, then former brokers, longest gone last. Never deleted. */
async function listTeam(pool, manager) {
  if (!isManager(manager)) return null;
  const { rows } = await pool.query(
    `SELECT b.id, b.name, b.role, b.is_active, b.phone_number, b.preferred_lang, b.last_active_at, b.telegram_linked_at,
            b.away_until, b.deactivated_at, b.notify_prefs, b.target_deals, b.target_commission, (b.telegram_chat_id IS NOT NULL) AS telegram,
            (SELECT max(t.expires_at) FROM telegram_link_tokens t WHERE t.broker_id = b.id AND t.used_at IS NULL AND t.expires_at > NOW()) AS link_until
       FROM brokers b WHERE b.agency_id = $1
      ORDER BY b.is_active DESC, CASE WHEN b.is_active THEN b.name END, b.deactivated_at DESC NULLS LAST, b.name`,
    [manager.agency_id]
  );
  return rows;
}

/**
 * The team board: each active member with open, overdue and due-today leads (counts only cover leads this person may see). A manager
 * sees everyone, a team lead themselves and their own team; anyone else gets null. Used by the app (GET /team) and the website's Team page.
 */
async function teamBoard(pool, broker) {
  const manager = isManager(broker);
  if (!manager && String(broker?.role || "").toLowerCase() !== "team_lead") return null;
  const Vis = require("../lib/visibility");
  const members = (
    await pool.query(
      `SELECT id, name, role, away_until, team_lead_id FROM brokers
        WHERE agency_id = $1 AND is_active AND ($2::boolean OR id = $3 OR team_lead_id = $3)
        ORDER BY (id = $3) DESC, name`,
      [broker.agency_id, manager, broker.id]
    )
  ).rows;
  const ids = members.map((m) => m.id);
  const counts = new Map(
    (
      await pool.query(
        `SELECT l.assigned_broker_id AS id,
                count(*) FILTER (WHERE l.stage NOT IN ('won', 'lost'))::int AS open,
                count(*) FILTER (WHERE l.follow_up_status = 'open' AND l.next_follow_up_at < now())::int AS overdue,
                count(*) FILTER (WHERE l.follow_up_status = 'open' AND l.next_follow_up_at >= now() AND l.next_follow_up_at < now() + interval '1 day')::int AS soon
           FROM leads l WHERE ${Vis.leads("l")} AND l.agency_id = $1 AND l.assigned_broker_id = ANY($2::uuid[]) GROUP BY l.assigned_broker_id`,
        [broker.agency_id, ids]
      )
    ).rows.map((r) => [r.id, r])
  );
  return members.map((m) => {
    const c = counts.get(m.id) || {};
    const away = m.away_until && new Date(m.away_until) > new Date();
    return { id: m.id, name: m.name, role: m.role, teamLeadId: m.team_lead_id || null, me: m.id === broker.id, away: Boolean(away), open: c.open || 0, overdue: c.overdue || 0, soon: c.soon || 0 };
  });
}

/**
 * A start link for one of the manager's brokers: { url, broker } or { error }. Never for someone already on Telegram
 * (tapping a link moves the account to whoever taps it) and never for a role above the manager's.
 */
async function startLinkFor(pool, manager, brokerId, { username = getConfig().telegram.botUsername } = {}) {
  if (!isManager(manager)) return { error: "forbidden" };
  if (!TgLink.startLink(username, "x")) return { error: "no_bot" };
  const { rows } = await pool.query("SELECT id, agency_id, name, role, phone_number, is_active, telegram_chat_id FROM brokers WHERE id = $1 AND agency_id = $2", [brokerId, manager.agency_id]);
  const broker = rows[0];
  if (!broker) return { error: "not_found" };
  if (!mayActOn(manager, broker.role)) return { error: "rank" };
  if (!broker.is_active) return { error: "inactive" };
  if (broker.telegram_chat_id) return { error: "linked" };
  return { url: TgLink.startLink(username, await TgLink.issueLinkToken(pool, broker)), broker };
}

/**
 * Adds a broker to the manager's agency (or reactivates one of theirs with that mobile) and returns their start link.
 * @param {Object} input - { name, phone, role, lang }
 * @returns {Promise<{ ok: true, broker, url, created } | { error }>}
 */
async function invite(pool, manager, input = {}, opts = {}) {
  if (!isManager(manager)) return { error: "forbidden" };
  const name = String(input.name || "").trim().slice(0, 80);
  const digits = Phone.normalizePhone(input.phone);
  const role = ADD_ROLES.includes(String(input.role || "broker")) ? String(input.role || "broker") : null;
  if (!name) return { error: "name" };
  if (!digits || !Phone.isEgyptMobile(digits)) return { error: "phone" };
  if (!role) return { error: "role" };
  // Only the agency owner adds managers; managers add brokers.
  if (role === "manager" && !isAgencyOwner(manager)) return { error: "forbidden" };
  const lang = input.lang === "en" ? "en" : "ar";
  const { rows: found } = await pool.query("SELECT id, agency_id, role, is_active FROM brokers WHERE phone_normalized = $1", [digits]);
  let brokerId;
  let created = false;
  if (found[0] && found[0].agency_id !== manager.agency_id) return { error: "phone_taken" };
  if (found[0] && !mayActOn(manager, found[0].role)) return { error: "rank" };
  // Someone already active on the team is never renamed or re-roled by an invite (it only brings back a deactivated member).
  if (found[0] && found[0].is_active) return { error: "already_member" };
  // A new or returning broker takes a seat; the plan's seats are the ceiling (existing ones are never removed).
  if (!found[0]?.is_active && !(await Billing.seatAvailable(pool, manager.agency_id))) return { error: "seats" };
  if (found[0]) {
    // One of ours: bring them back; an admin or owner keeps their role.
    const keep = !ADD_ROLES.includes(String(found[0].role || "").toLowerCase());
    await pool.query("UPDATE brokers SET name = $2, role = CASE WHEN $4 THEN role ELSE $3 END, is_active = true, deactivated_at = NULL WHERE id = $1", [found[0].id, name, role, keep]);
    brokerId = found[0].id;
  } else {
    const { rows } = await pool.query(
      `INSERT INTO brokers (agency_id, phone_number, name, role, preferred_lang, is_active) VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
      [manager.agency_id, digits, name, role, lang]
    );
    brokerId = rows[0].id;
    created = true;
  }
  forgetWorkspace(manager.agency_id);
  const link = await startLinkFor(pool, manager, brokerId, opts);
  const { rows: b } = await pool.query("SELECT id, name, role, phone_number, preferred_lang FROM brokers WHERE id = $1", [brokerId]);
  return { ok: true, broker: b[0], url: link.url || null, created, noBot: link.error === "no_bot" };
}

/** Deactivates one of the manager's brokers (never themselves, never a role above theirs); their leads go to the unassigned pool. */
async function deactivate(pool, manager, brokerId, { now = new Date() } = {}) {
  if (!isManager(manager)) return { error: "forbidden" };
  if (!UUID_RE.test(String(brokerId || ""))) return { error: "not_found" };
  if (brokerId === manager.id) return { error: "self" };
  const { rows } = await pool.query("SELECT role FROM brokers WHERE id = $1 AND agency_id = $2", [brokerId, manager.agency_id]);
  if (!rows[0]) return { error: "not_found" };
  if (!mayActOn(manager, rows[0].role)) return { error: "rank" };
  const out = await Brokers.deactivateBroker(pool, { agencyId: manager.agency_id, brokerId, actorId: manager.id, now });
  forgetWorkspace(manager.agency_id);
  return out;
}

/** Brings a deactivated broker back with the same role (a seat must be free). Their old leads stay with the managers. */
async function reactivate(pool, manager, brokerId) {
  if (!isManager(manager)) return { error: "forbidden" };
  if (!UUID_RE.test(String(brokerId || ""))) return { error: "not_found" };
  const { rows } = await pool.query("SELECT id, name, role, is_active FROM brokers WHERE id = $1 AND agency_id = $2", [brokerId, manager.agency_id]);
  const b = rows[0];
  if (!b) return { error: "not_found" };
  if (!mayActOn(manager, b.role)) return { error: "rank" };
  if (b.is_active) return { ok: true, broker: b };
  if (!(await Billing.seatAvailable(pool, manager.agency_id))) return { error: "seats" };
  await pool.query("UPDATE brokers SET is_active = true, deactivated_at = NULL WHERE id = $1", [brokerId]);
  forgetWorkspace(manager.agency_id);
  return { ok: true, broker: b };
}

/**
 * Deletes a DEACTIVATED broker for good (never themselves, never a role above the actor's). A broker who still owns deals or
 * listings cannot be erased (the database refuses); they stay deactivated: { error: "has_records" }.
 */
async function remove(pool, manager, brokerId) {
  if (!isManager(manager)) return { error: "forbidden" };
  if (!UUID_RE.test(String(brokerId || ""))) return { error: "not_found" };
  if (brokerId === manager.id) return { error: "self" };
  const { rows } = await pool.query("SELECT id, name, role, is_active FROM brokers WHERE id = $1 AND agency_id = $2", [brokerId, manager.agency_id]);
  const b = rows[0];
  if (!b) return { error: "not_found" };
  if (!mayActOn(manager, b.role)) return { error: "rank" };
  if (b.is_active) return { error: "active" };
  forgetWorkspace(manager.agency_id);
  try {
    await pool.query("DELETE FROM brokers WHERE id = $1 AND agency_id = $2 AND NOT is_active", [brokerId, manager.agency_id]);
  } catch (e) {
    if (e && e.code === "23503") return { error: "has_records" };
    throw e;
  }
  return { ok: true, broker: b };
}

/** The message a manager sends a new broker from their own WhatsApp: what WehdatHub is and the start link. */
function inviteText(broker, url, agencyName) {
  const en = broker.preferred_lang === "en";
  return en
    ? `Hi ${broker.name}! ${agencyName} added you to WehdatHub, our units and clients assistant on Telegram.\n1. Install Telegram if you don't have it.\n2. Tap this link (works once, for 7 days): ${url}`
    : `أهلاً ${broker.name}! ${agencyName} ضافك على WehdatHub، مساعد الوحدات والعملاء بتاعنا على تيليجرام.\n١. نزّل تيليجرام لو مش عندك.\n٢. دوس على اللينك ده (يشتغل مرة واحدة، لمدة ٧ أيام): ${url}`;
}

/**
 * The agency owner moves a broker to manager or back. Never their own role, never an admin or owner.
 * Pending private-data requests are not moved here: each approval re-reads the approver's role.
 * @returns {Promise<{ ok: true, broker, from, to } | { error }>}
 */
async function changeRole(pool, owner, brokerId, newRole) {
  if (!isAgencyOwner(owner)) return { error: "forbidden" };
  if (!INVITE_ROLES.includes(String(newRole || ""))) return { error: "role" };
  if (brokerId === owner.id) return { error: "self" };
  const { rows } = await pool.query("SELECT id, name, role FROM brokers WHERE id = $1 AND agency_id = $2", [brokerId, owner.agency_id]);
  if (!rows[0]) return { error: "not_found" };
  const from = String(rows[0].role || "").toLowerCase();
  if (TOP_ROLES.includes(from)) return { error: "rank" };
  if (from === newRole) return { error: "same" };
  await pool.query("UPDATE brokers SET role = $2 WHERE id = $1", [brokerId, newRole]);
  return { ok: true, broker: rows[0], from, to: newRole };
}

/**
 * A manager or the owner makes a broker a team lead, or takes the role back. Taking it back clears the team under them.
 * Returns { ok, broker, to } | { error }.
 */
async function setTeamLeadRole(pool, manager, brokerId, on) {
  if (!MANAGER_ROLES.includes(String(manager.role || "").toLowerCase())) return { error: "forbidden" };
  if (brokerId === manager.id) return { error: "self" };
  const { rows } = await pool.query("SELECT id, name, role FROM brokers WHERE id = $1 AND agency_id = $2", [brokerId, manager.agency_id]);
  if (!rows[0]) return { error: "not_found" };
  const from = String(rows[0].role || "").toLowerCase();
  if (TOP_ROLES.includes(from)) return { error: "rank" };
  if (on && from === "team_lead") return { error: "same" };
  if (!on && from !== "team_lead") return { error: "same" };
  const to = on ? "team_lead" : "broker";
  await pool.query("UPDATE brokers SET role = $2 WHERE id = $1", [brokerId, to]);
  if (!on) {
    await pool.query("UPDATE broker_team_history SET to_at = now() WHERE team_lead_id = $1 AND agency_id = $2 AND to_at IS NULL", [brokerId, manager.agency_id]);
    await pool.query("UPDATE brokers SET team_lead_id = NULL WHERE team_lead_id = $1 AND agency_id = $2", [brokerId, manager.agency_id]);
  }
  forgetWorkspace(manager.agency_id);
  return { ok: true, broker: rows[0], from, to };
}

/** A manager puts a broker in a team (under a team lead), or takes them out (teamLeadId null). Returns { ok } | { error }. */
async function setTeam(pool, manager, brokerId, teamLeadId) {
  if (!MANAGER_ROLES.includes(String(manager.role || "").toLowerCase())) return { error: "forbidden" };
  const { rows } = await pool.query("SELECT id, role FROM brokers WHERE id = $1 AND agency_id = $2", [brokerId, manager.agency_id]);
  if (!rows[0]) return { error: "not_found" };
  if (String(rows[0].role || "").toLowerCase() === "team_lead" && teamLeadId) return { error: "team_lead_nested" };
  if (teamLeadId) {
    const lead = (await pool.query("SELECT id FROM brokers WHERE id = $1 AND agency_id = $2 AND is_active AND lower(role) = 'team_lead'", [teamLeadId, manager.agency_id])).rows[0];
    if (!lead) return { error: "team_lead_not_found" };
  }
  // The team history: the old team ends now and the new one starts now (only when the team really changes).
  const cur = (await pool.query("SELECT team_lead_id FROM brokers WHERE id = $1", [brokerId])).rows[0]?.team_lead_id || null;
  if (cur !== (teamLeadId || null)) {
    await pool.query("UPDATE broker_team_history SET to_at = now() WHERE broker_id = $1 AND to_at IS NULL", [brokerId]);
    if (teamLeadId) await pool.query("INSERT INTO broker_team_history (agency_id, broker_id, team_lead_id) VALUES ($1, $2, $3)", [manager.agency_id, brokerId, teamLeadId]);
  }
  await pool.query("UPDATE brokers SET team_lead_id = $2 WHERE id = $1", [brokerId, teamLeadId || null]);
  return { ok: true };
}

module.exports = { INVITE_ROLES, ADD_ROLES, listTeam, teamBoard, startLinkFor, invite, deactivate, reactivate, remove, inviteText, changeRole, setTeamLeadRole, setTeam };
