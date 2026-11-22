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

// Agencies that already use an agency-tier feature keep it (nothing they run today stops): team leads, data entry, lead rules, private items,
// lead sources, won/lost leads. Read in the same query as the other facts; a missing table or column → nothing kept (the feature rules then decide).
const KEEP_COLS = `
  COALESCE(a.crm_settings->>'brokers_work_shared_leads' = 'true', false) AS work_shared_leads,
  COALESCE(a.crm_settings->>'brokers_edit_colleague_units' = 'true', false) AS edit_colleague_units,
  COALESCE(a.crm_settings->>'brokers_see_all_leads' <> 'false', true) AS see_all_leads,
  COALESCE(a.crm_settings->>'team_workflow_configured' = 'true', false) AS workflow_configured,
  EXISTS (SELECT 1 FROM brokers x WHERE x.agency_id = a.id AND x.is_active AND lower(x.role) = 'team_lead') AS k_team_lead,
  EXISTS (SELECT 1 FROM brokers x WHERE x.agency_id = a.id AND x.is_active AND lower(x.role) = 'data_entry') AS k_data_entry,
  COALESCE(a.lead_rules->>'enabled' = 'true', false) AS k_lead_rules,
  (EXISTS (SELECT 1 FROM listings x WHERE x.agency_id = a.id AND x.is_private) OR EXISTS (SELECT 1 FROM unit_owners x WHERE x.agency_id = a.id AND x.is_private) OR EXISTS (SELECT 1 FROM leads x WHERE x.agency_id = a.id AND x.is_private)) AS k_private,
  (EXISTS (SELECT 1 FROM ad_spend x WHERE x.agency_id = a.id) OR EXISTS (SELECT 1 FROM leads x WHERE x.agency_id = a.id AND COALESCE(x.source, '') <> '')) AS k_sources,
  EXISTS (SELECT 1 FROM leads x WHERE x.agency_id = a.id AND x.stage IN ('won', 'lost')) AS k_win_loss`;
const keepOf = (r) => [r?.k_team_lead && "teamLead", r?.k_data_entry && "dataEntry", r?.k_lead_rules && "leadRules", r?.k_private && "privateUnits", r?.k_sources && "sources", r?.k_win_loss && "winLoss"].filter(Boolean);
const MISSING = new Set(["42703", "42P01"]); // column or table not there yet (migration not applied)

async function readFacts(pool, agencyId) {
  const sql = (cols) => `SELECT ${cols}, (SELECT count(*)::int FROM brokers b WHERE b.agency_id = a.id AND b.is_active) AS members FROM agencies a WHERE a.id = $1`;
  for (const cols of [`a.team_style, a.analytics_enabled, ${KEEP_COLS}`, "a.team_style, a.analytics_enabled", "a.analytics_enabled"]) {
    try {
      return (await pool.query(sql(cols), [agencyId])).rows[0];
    } catch (e) {
      if (!MISSING.has(e?.code)) throw e;
    }
  }
  return undefined;
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
    // A solo plan with more than one active member (extra seats, a downgrade) keeps working as a team: nothing is taken away.
    const planTier = Segments.tierOf(plan.plan, { pilot: plan.pilot });
    const tier = planTier === "solo" && members > 1 ? "team" : planTier;
    const keep = tier === "agency" ? [] : keepOf(facts);
    const teamWithPeers = tier === "team" && !Segments.isLone(members);
    hit = { pool, at: Date.now(), base: {
      tier, keep, members, solo: Segments.isLone(members),
      teamStyle: Segments.styleFor(tier, facts?.team_style),
      analytics: Boolean(facts?.analytics_enabled),
      brokersWorkSharedLeads: teamWithPeers && Boolean(facts?.work_shared_leads),
      brokersEditColleagueUnits: teamWithPeers && Boolean(facts?.edit_colleague_units),
      brokersSeeAllLeads: facts?.see_all_leads !== false,
      teamWorkflowConfigured: teamWithPeers && Boolean(facts?.workflow_configured)
    } };
    memo.set(agencyId, hit);
  }
  const { base } = hit;
  return { ...base, mode: Segments.modeOf({ tier: base.tier, activeMembers: base.members, role }) };
}

module.exports = { stateOf, forget, forgetAll };
