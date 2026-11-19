// lib/workspace.js — What kind of workspace an agency is, for menus, pages, the API and the bot:
// { tier, mode, members, solo, teamStyle, analytics }. One query for the new facts, kept 15 s per agency (like planGuard.stateOf,
// which supplies the plan from its own memo). Every write that changes the plan or the people calls forget(agencyId).
// The rules themselves live in domain/segments.js; this file only reads the facts.
"use strict";

const Segments = require("../domain/segments");
const PlanGuard = require("./planGuard");

const TTL_MS = 15 * 1000;
const memo = new Map(); // agency id → { pool, at, base }: the facts that do not depend on who is asking

const forget = (agencyId) => memo.delete(agencyId);
const forgetAll = () => memo.clear();

async function readFacts(pool, agencyId) {
  const sql = (cols) => `SELECT ${cols}, (SELECT count(*)::int FROM brokers b WHERE b.agency_id = a.id AND b.is_active) AS members FROM agencies a WHERE a.id = $1`;
  try {
    return (await pool.query(sql("a.team_style, a.analytics_enabled"), [agencyId])).rows[0];
  } catch (e) {
    if (e?.code !== "42703") throw e; // migration 139 not applied yet: defaults
    return (await pool.query(sql("a.analytics_enabled"), [agencyId])).rows[0];
  }
}

/**
 * The workspace of an agency, for `role` (the asker's role, only used for the mode).
 * → { tier, mode, members, solo, teamStyle, analytics }. No agency id → a lone solo workspace.
 */
async function stateOf(pool, agencyId, { role = "owner", now } = {}) {
  if (!agencyId) return { tier: "solo", mode: "solo", members: 1, solo: true, teamStyle: "shared", analytics: false };
  let hit = memo.get(agencyId);
  if (!(hit && hit.pool === pool && Date.now() - hit.at < TTL_MS)) {
    const [plan, facts] = await Promise.all([PlanGuard.stateOf(pool, agencyId, now ? { now } : undefined), readFacts(pool, agencyId)]);
    const members = facts?.members ?? 1;
    const tier = Segments.tierOf(plan.plan, { pilot: plan.pilot });
    hit = { pool, at: Date.now(), base: { tier, members, solo: Segments.isLone(members), teamStyle: Segments.styleFor(tier, facts?.team_style), analytics: Boolean(facts?.analytics_enabled) } };
    memo.set(agencyId, hit);
  }
  const { base } = hit;
  return { ...base, mode: Segments.modeOf({ tier: base.tier, activeMembers: base.members, role }) };
}

module.exports = { stateOf, forget, forgetAll };
