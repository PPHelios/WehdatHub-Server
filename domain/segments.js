// domain/segments.js — Which kind of workspace this is (solo, team, agency) and which features it gets. Pure: no database.
// This file and lib/workspace.js are the ONLY places that compare plan seats or member counts to decide that; menus, pages,
// the API and the bot ask allows(ws, feature) (tests/lint/segments-lint.test.js keeps it that way).
// Mode only HIDES things; it never grants a right (roles and the unit/lead rules in lib/authz.js still decide who may do what).
"use strict";

const TIERS = ["solo", "team", "agency"];
const AGENCY_SEATS = 15; // Office (15 seats) and above, or any pilot
const TEAM_STYLES = ["shared", "structured"]; // shared is the default

const rank = (tier) => Math.max(0, TIERS.indexOf(tier));

/** solo (1 seat) | team (2 to 14 seats) | agency (15 seats or more, or a pilot). `plan` is { seats }; trial and free have 1 seat. */
function tierOf(plan, { pilot = false } = {}) {
  const seats = Number(plan?.seats) || 1;
  if (pilot || seats >= AGENCY_SEATS) return "agency";
  return seats <= 1 ? "solo" : "team";
}

/** One active member (nobody else to share with). */
const isLone = (members) => Number(members) <= 1;

/**
 * What the screens look like: "solo" (lone owner below agency tier), "team", or "agency".
 * A lone person who is NOT the owner stays "team" so a broker keeps the broker menu. More than one active member is never "solo",
 * even on a solo plan after a downgrade (members are never removed).
 */
function modeOf({ tier, activeMembers, role }) {
  if (tier === "agency") return "agency";
  const owner = String(role || "").toLowerCase() === "owner";
  return isLone(activeMembers) && owner ? "solo" : "team";
}

// minTier: lowest tier that gets it. needsPeers: also needs another active member. nav/web/api/bot: where it is hidden when not allowed.
const ALL_SURFACES = { nav: true, web: true, api: true, bot: true };
const FEATURES = Object.freeze({
  assignLeads: { minTier: "team", needsPeers: true, ...ALL_SURFACES },
  teamPage: { minTier: "team", needsPeers: false, ...ALL_SURFACES }, // the invite page must work for a lone owner
  accessRequests: { minTier: "team", needsPeers: true, ...ALL_SURFACES },
  brokersEdit: { minTier: "team", needsPeers: true, ...ALL_SURFACES },
  seeAll: { minTier: "team", needsPeers: true, ...ALL_SURFACES },
  leadRules: { minTier: "agency", needsPeers: false, ...ALL_SURFACES },
  teamLead: { minTier: "agency", needsPeers: false, ...ALL_SURFACES },
  dataEntry: { minTier: "agency", needsPeers: false, ...ALL_SURFACES },
  sources: { minTier: "agency", needsPeers: false, ...ALL_SURFACES },
  winLoss: { minTier: "agency", needsPeers: false, ...ALL_SURFACES },
  privateUnits: { minTier: "agency", needsPeers: false, ...ALL_SURFACES } // never at team level and below
});

/** Does this workspace ({ tier, members }) get the feature? An unknown feature is never allowed. */
function allows(ws, feature) {
  const f = FEATURES[feature];
  if (!f || !ws) return false;
  if (Array.isArray(ws.keep) && ws.keep.includes(feature)) return true; // grandfathered: the agency already uses it (lib/workspace.js keepOf)
  if (rank(ws.tier) < rank(f.minTier)) return false;
  // The agency tier (and pilots) never loses a feature for having one member: only the tiers below need a second person.
  return !f.needsPeers || rank(ws.tier) >= rank("agency") || !isLone(ws.members);
}

// Roles the invite form may offer: broker and manager everywhere; team leads and data entry only where the plan has them (or the agency already uses them).
const BASIC_INVITE_ROLES = ["broker", "manager"];
const ROLE_FEATURE = { team_lead: "teamLead", data_entry: "dataEntry" };
/** The roles an invite may name in this workspace, out of `roles` (the roles the server knows). */
const inviteRolesFor = (ws, roles) => roles.filter((r) => BASIC_INVITE_ROLES.includes(r) || (ROLE_FEATURE[r] ? allows(ws, ROLE_FEATURE[r]) : ws?.tier === "agency"));

/** team_style only matters on the team tier and below (agency tier is unaffected). */
const styleFor = (tier, style) => (tier === "agency" ? "structured" : TEAM_STYLES.includes(style) ? style : "shared");

module.exports = { TIERS, TEAM_STYLES, AGENCY_SEATS, FEATURES, tierOf, modeOf, isLone, allows, inviteRolesFor, styleFor };
