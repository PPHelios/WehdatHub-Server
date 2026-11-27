// tests/unit/entitlements.test.js — Every FEATURES row x workspace x role: when the workspace does not get the feature, the menu has no
// item for it, the website path answers 403 and the app API path answers 403 `plan_feature` with ONE upgrade line. Agency tier allows all.
"use strict";

const Seg = require("../../domain/segments");
const Nav = require("../../lib/navSpec");
const Ent = require("../../lib/entitlements");

const ID = "11111111-1111-1111-1111-111111111111";
// One real path per surface for each feature (the regexes in lib/entitlements.js PATHS must match them).
const SAMPLE = {
  assignLeads: { web: "/leads/L-0001/assign", api: "/leads/L-0001/assign" },
  teamPage: { web: "/team", api: "/team" },
  accessRequests: { web: "/access-requests", api: "/access-requests" },
  brokersEdit: { web: "/dashboard/brokers-edit-units", api: null },
  seeAll: { web: "/dashboard/brokers-see-all-leads", api: null },
  leadRules: { web: "/team/rules", api: "/team/rules" },
  teamLead: { web: `/team/${ID}/team-role`, api: `/team/${ID}/team-role` },
  dataEntry: { web: null, api: null },
  sources: { web: "/sources", api: "/sources" },
  winLoss: { web: "/winloss", api: "/insights/winloss" },
  privateUnits: { web: "/units/NH-1/portfolio", api: `/owners/${ID}/portfolio` }
};
const SPACES = [
  { name: "solo", ws: { tier: "solo", members: 1, keep: [] } },
  { name: "team lone owner", ws: { tier: "team", members: 1, keep: [] } },
  { name: "team with peers", ws: { tier: "team", members: 4, keep: [] } }
];
const ROLES = ["owner", "manager", "team_lead", "broker"];

const run = (mw, req) =>
  new Promise((resolve) => {
    const res = {
      code: 200,
      status(c) { this.code = c; return this; },
      type() { return this; },
      send(b) { resolve({ code: this.code, body: b }); },
      json(b) { resolve({ code: this.code, body: b }); }
    };
    mw(req, res, () => resolve({ code: 200 }));
  });

test("the path table covers every feature and its samples match", () => {
  expect(Object.keys(Ent.PATHS).sort()).toEqual(Object.keys(Seg.FEATURES).sort());
  for (const [f, s] of Object.entries(SAMPLE)) {
    if (s.web) expect(Ent.featuresOf("web", s.web)).toContain(f);
    if (s.api) expect(Ent.featuresOf("api", s.api)).toContain(f);
  }
});

describe.each(Object.keys(Seg.FEATURES))("feature %s", (feature) => {
  test.each(SPACES)("not allowed in $name: no menu item, web 403, api 403", async ({ ws }) => {
    if (Seg.allows(ws, feature)) return; // this workspace gets it: nothing to hide
    for (const role of ROLES) {
      const mode = Seg.modeOf({ tier: ws.tier, activeMembers: ws.members, role });
      const broker = { id: "b", role, agency_id: "a", workspace: { ...ws, mode } };
      const menu = Nav.forBroker(broker);
      const shown = [...menu.tabs.map((t) => t.key), ...menu.groups.flatMap((g) => g.items.map((i) => i.key))];
      // Every menu item or tab that names this feature is gone.
      for (const i of [...Nav.ITEMS, ...Object.values(Nav.TABS).flat()].filter((x) => x.feature === feature)) expect(shown).not.toContain(i.key);
      if (SAMPLE[feature].web) {
        const r = await run(Ent.web(null), { session: { broker }, path: SAMPLE[feature].web, method: "POST", get: () => null, lang: "ar" });
        expect(r.code).toBe(403);
      }
      if (SAMPLE[feature].api) {
        const r = await run(Ent.api(null), { session: { broker }, path: SAMPLE[feature].api, method: "POST" });
        expect(r.code).toBe(403);
        expect(r.body).toMatchObject({ error: "plan_feature" });
        expect(Ent.featuresOf("api", SAMPLE[feature].api)).toContain(r.body.feature);
        expect(r.body.message).toBeTruthy();
      }
      expect(await Ent.assertAllowed(null, broker, feature)).toEqual({ error: "plan_feature", feature });
    }
  });
});

test("agency tier and pilots: nothing is refused", async () => {
  const broker = { id: "b", role: "owner", agency_id: "a", workspace: { tier: "agency", mode: "agency", members: 1, keep: [] } };
  for (const [f, s] of Object.entries(SAMPLE)) {
    if (s.web) expect((await run(Ent.web(null), { session: { broker }, path: s.web, method: "POST", get: () => null })).code).toBe(200);
    if (s.api) expect((await run(Ent.api(null), { session: { broker }, path: s.api, method: "POST" })).code).toBe(200);
    expect(await Ent.assertAllowed(null, broker, f)).toBeNull();
  }
});

test("a grandfathered feature stays allowed; a missing workspace or a failing read never blocks", async () => {
  const broker = { id: "b", role: "owner", agency_id: "a", workspace: { tier: "team", mode: "team", members: 3, keep: ["sources"] } };
  expect(await Ent.assertAllowed(null, broker, "sources")).toBeNull();
  expect(await Ent.assertAllowed(null, broker, "winLoss")).not.toBeNull();
  const failing = { query: () => Promise.reject(new Error("db down")) };
  expect(await Ent.assertAllowed(failing, { id: "b", role: "owner", agency_id: "a" }, "sources")).toBeNull();
  expect(await Ent.assertAllowed(failing, { id: "b", role: "owner" }, "sources")).toBeNull();
});

test("invite roles: broker and manager below agency; team lead and data entry only where the plan (or past use) has them", async () => {
  const roles = ["broker", "manager", "data_entry", "team_lead"];
  const mk = (workspace) => ({ id: "b", role: "owner", agency_id: "a", workspace });
  expect(await Ent.inviteRoles(null, mk({ tier: "team", members: 3, keep: [] }), roles)).toEqual(["broker", "manager"]);
  expect(await Ent.inviteRoles(null, mk({ tier: "team", members: 3, keep: ["teamLead"] }), roles)).toEqual(["broker", "manager", "team_lead"]);
  expect(await Ent.inviteRoles(null, mk({ tier: "agency", members: 3, keep: [] }), roles)).toEqual(roles);
});

test("team style: only the agency owner on a team tier may flip it, and the workspace memo is dropped", async () => {
  const Team = require("../../services/team");
  const Workspace = require("../../lib/workspace");
  const queries = [];
  const pool = { query: async (sql, args) => { queries.push(args); return { rows: [] }; } };
  expect(await Team.setTeamStyle(pool, { role: "manager", agency_id: "a" }, "structured")).toEqual({ error: "forbidden" });
  expect(await Team.setTeamStyle(pool, { role: "broker", agency_id: "a" }, "structured")).toEqual({ error: "forbidden" });
  expect(queries).toHaveLength(0);
  expect(await Team.setTeamStyle(pool, { role: "owner", agency_id: "a" }, "bogus")).toEqual({ error: "style" });
  const wsSpy = jest.spyOn(Workspace, "stateOf").mockResolvedValue({ tier: "solo", mode: "solo", members: 1, keep: [] });
  expect(await Team.setTeamStyle(pool, { role: "owner", agency_id: "a" }, "structured")).toEqual({ error: "plan_feature" });
  wsSpy.mockResolvedValue({ tier: "team", mode: "team", members: 3, keep: [] });
  const spy = jest.spyOn(Workspace, "forget");
  expect(await Team.setTeamStyle(pool, { role: "owner", agency_id: "a" }, "structured")).toEqual({ ok: true, style: "structured" });
  expect(spy).toHaveBeenCalledWith("a");
  spy.mockRestore();
  wsSpy.mockRestore();
});

test("services refuse by plan: team lead role, lead rules, invite of data entry on the team tier", async () => {
  const Team = require("../../services/team");
  const LeadRules = require("../../services/leadRules");
  const owner = { id: "o", role: "owner", agency_id: "a", workspace: { tier: "team", mode: "team", members: 3, keep: [] } };
  const pool = { query: async () => ({ rows: [] }) };
  expect(await Team.setTeamLeadRole(pool, owner, "22222222-2222-2222-2222-222222222222", true)).toMatchObject({ error: "plan_feature" });
  expect(await LeadRules.saveRules(pool, owner, {})).toMatchObject({ error: "plan_feature" });
  expect(await Team.invite(pool, owner, { name: "Ali", phone: "01012345678", role: "data_entry" })).toEqual({ error: "plan_feature" });
});
