// services/aiUserLimits.js — The agency's AI usage mode and each person's monthly allowance (spec-server.md section 4).
// Two modes: "pool" (default: all AI use draws from the agency's monthly pool) and "per_user" (each person also has an
// allowance: one default for everyone, optional overrides per person). The pool still caps the agency in both modes.
// Only the agency owner changes the settings, unless the owner let managers do it (agencies.manager_can_edit_ai_settings).
// Every change is written to the audit log with who made it.
"use strict";

const Credits = require("./credits");
const Audit = require("./audit");
const { MANAGER_ROLES, isAgencyOwner } = require("../lib/authz");
const { logOperation } = require("../lib/db");

const MODES = ["pool", "per_user"];
const MAX_CREDITS = 1000000;
const isManagerRole = (b) => MANAGER_ROLES.includes(String(b?.role || "").toLowerCase());
/** null = blank (no number), undefined = not a valid number, else the whole number. */
const asCredits = (v) => {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= MAX_CREDITS ? n : undefined;
};

/** The agency's settings: { mode, defaultCredits, managerCanEdit }. */
async function settingsOf(db, agencyId) {
  const { rows } = await db.query("SELECT ai_usage_mode, ai_user_default_credits, manager_can_edit_ai_settings FROM agencies WHERE id = $1", [agencyId]);
  const r = rows[0] || {};
  return { mode: r.ai_usage_mode === "per_user" ? "per_user" : "pool", defaultCredits: r.ai_user_default_credits ?? null, managerCanEdit: r.manager_can_edit_ai_settings === true };
}

/**
 * One person's allowance now: { mode, allowance (null = none: pool mode, or no limit set), override, used, remaining }.
 * Used is counted the way the pool counts (services/credits.js usedThisMonth) but for this person only.
 */
async function standing(db, agencyId, brokerId, { now = new Date() } = {}) {
  const { rows } = await db.query(
    `SELECT a.ai_usage_mode, a.ai_user_default_credits, b.ai_user_credits
       FROM agencies a JOIN brokers b ON b.agency_id = a.id AND b.id = $2 WHERE a.id = $1`,
    [agencyId, brokerId]
  );
  const r = rows[0];
  const mode = r?.ai_usage_mode === "per_user" ? "per_user" : "pool";
  const override = r?.ai_user_credits ?? null;
  const allowance = mode === "per_user" ? override ?? r?.ai_user_default_credits ?? null : null;
  const used = await Credits.usedThisMonth(db, agencyId, { now, brokerId });
  return { mode, allowance, override, used, remaining: allowance == null ? null : Math.max(0, allowance - used) };
}

/** { blocked, ...standing }: blocked when this person has spent their own allowance (never in pool mode). */
async function overOwnLimit(db, agencyId, brokerId, { now = new Date() } = {}) {
  const s = await standing(db, agencyId, brokerId, { now });
  return { blocked: s.allowance != null && s.used >= s.allowance, ...s };
}

/** May this person change the settings? The agency owner always; a manager only when the owner allowed it. */
async function mayEdit(db, broker) {
  if (isAgencyOwner(broker)) return true;
  if (!isManagerRole(broker)) return false;
  return (await settingsOf(db, broker.agency_id)).managerCanEdit;
}

/** Everyone active in the agency with their allowance and use this month (for the owner and managers). */
async function people(db, agencyId, { now = new Date() } = {}) {
  const set = await settingsOf(db, agencyId);
  const { rows } = await db.query("SELECT id, name, role, ai_user_credits FROM brokers WHERE agency_id = $1 AND is_active ORDER BY name", [agencyId]);
  const out = [];
  for (const b of rows) {
    const used = await Credits.usedThisMonth(db, agencyId, { now, brokerId: b.id });
    const allowance = set.mode === "per_user" ? b.ai_user_credits ?? set.defaultCredits ?? null : null;
    out.push({ id: b.id, name: b.name, role: b.role, override: b.ai_user_credits ?? null, allowance, used });
  }
  return out;
}

/** What a screen needs about this person: their own standing, whether they may edit, and (managers) everyone. */
async function overview(db, broker, { now = new Date() } = {}) {
  const [set, me, canEdit] = await Promise.all([settingsOf(db, broker.agency_id), standing(db, broker.agency_id, broker.id, { now }), mayEdit(db, broker)]);
  const out = { mode: set.mode, defaultCredits: set.defaultCredits, managerCanEdit: set.managerCanEdit, canEdit, mine: { allowance: me.allowance, used: me.used, remaining: me.remaining } };
  if (isManagerRole(broker)) out.people = await people(db, broker.agency_id, { now });
  return out;
}

/**
 * Saves mode, default and per-person overrides. changes: { mode?, defaultCredits?, overrides?: { brokerId: number|"" } }.
 * @returns {Promise<{ ok: true } | { ok: false, error: "forbidden"|"mode"|"credits" }>}
 */
async function save(pool, actor, changes = {}) {
  if (!(await mayEdit(pool, actor))) return { ok: false, error: "forbidden" };
  const agencyId = actor.agency_id;
  const patch = {};
  if (changes.mode !== undefined) {
    if (!MODES.includes(changes.mode)) return { ok: false, error: "mode" };
    patch.mode = changes.mode;
  }
  if (changes.defaultCredits !== undefined) {
    const n = asCredits(changes.defaultCredits);
    if (n === undefined) return { ok: false, error: "credits" };
    patch.defaultCredits = n;
  }
  const overrides = {};
  for (const [id, v] of Object.entries(changes.overrides || {})) {
    const n = asCredits(v);
    if (n === undefined) return { ok: false, error: "credits" };
    overrides[id] = n;
  }
  await Audit.recordStrict(pool, { agencyId, brokerId: actor.id, action: "ai_usage_settings", targetType: "agency", targetId: agencyId, payload: { ...patch, overrides } });
  if (patch.mode !== undefined) await pool.query("UPDATE agencies SET ai_usage_mode = $2 WHERE id = $1", [agencyId, patch.mode]);
  if (patch.defaultCredits !== undefined) await pool.query("UPDATE agencies SET ai_user_default_credits = $2 WHERE id = $1", [agencyId, patch.defaultCredits]);
  for (const [id, n] of Object.entries(overrides)) await pool.query("UPDATE brokers SET ai_user_credits = $3 WHERE id = $1 AND agency_id = $2", [id, agencyId, n]);
  logOperation(pool, { agency_id: agencyId, broker_id: actor.id, operation_type: "ai_usage_settings", status: "success", metadata: { mode: patch.mode ?? null, changed_people: Object.keys(overrides).length } });
  return { ok: true };
}

/** Only the agency owner lets managers change the settings. */
async function setManagerCanEdit(pool, owner, allowed) {
  if (!isAgencyOwner(owner)) return { ok: false, error: "forbidden" };
  const value = allowed === true || allowed === "true" || allowed === "on" || allowed === "1";
  await Audit.recordStrict(pool, { agencyId: owner.agency_id, brokerId: owner.id, action: "manager_can_edit_ai_settings", targetType: "agency", targetId: owner.agency_id, payload: { allowed: value } });
  await pool.query("UPDATE agencies SET manager_can_edit_ai_settings = $2 WHERE id = $1", [owner.agency_id, value]);
  logOperation(pool, { agency_id: owner.agency_id, broker_id: owner.id, operation_type: "manager_can_edit_ai_settings", status: "success", metadata: { allowed: value } });
  return { ok: true, allowed: value };
}

module.exports = { MODES, settingsOf, standing, overOwnLimit, mayEdit, people, overview, save, setManagerCanEdit };
