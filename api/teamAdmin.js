// api/teamAdmin.js — Team changes for the app: invite, change a role (agency owner), deactivate. Same services and rules as the
// website (services/team.js). Only the agency owner adds managers or changes roles.
"use strict";

const Team = require("../services/team");
const Audit = require("../services/audit");
const { logOperation } = require("../lib/db");

const STATUS = { plan_feature: 403, forbidden: 403, not_found: 404, rank: 403, phone_taken: 409, already_member: 409, seats: 402, self: 409, active: 409, has_records: 409, same: 409, team_lead_nested: 409, team_lead_not_found: 404 };
const UUID = /^[0-9a-f-]{36}$/i;
const fail = (res, error) => res.status(STATUS[error] || 422).json({ error });

function register(api, { pool }) {
  // Deactivated members (the app's "Deactivated" tab). Managers and the owner only.
  api.get("/team/former", async (req, res) => {
    const team = await Team.listTeam(pool, req.session.broker);
    if (!team) return fail(res, "forbidden");
    return res.json({ items: team.filter((b) => !b.is_active).map((b) => ({ id: b.id, name: b.name, role: b.role, deactivatedAt: b.deactivated_at })) });
  });

  api.post("/team/invite", async (req, res) => {
    const r = await Team.invite(pool, req.session.broker, { name: req.body?.name, phone: req.body?.phone, role: req.body?.role, lang: req.body?.lang });
    if (r.error) return fail(res, r.error);
    return res.json({ ok: true, created: r.created, broker: { id: r.broker.id, name: r.broker.name, role: r.broker.role }, url: r.url, noBot: Boolean(r.noBot) });
  });

  // The agency owner picks how a team below the agency tier works: "shared" or "structured" (services/team.js setTeamStyle).
  api.post("/team/style", async (req, res) => {
    const r = await Team.setTeamStyle(pool, req.session.broker, String(req.body?.style || ""));
    return r.error ? fail(res, r.error) : res.json({ ok: true, style: r.style });
  });

  api.post("/team/:id/role", async (req, res) => {
    const owner = req.session.broker;
    try {
      await Audit.recordStrict(pool, { agencyId: owner.agency_id, brokerId: owner.id, action: "team_role_change", targetType: "broker", targetId: req.params.id, payload: { role: String(req.body?.role || "") } });
    } catch {
      return res.status(503).json({ error: "audit" });
    }
    const r = await Team.changeRole(pool, owner, req.params.id, String(req.body?.role || ""));
    return r.error ? fail(res, r.error) : res.json({ ok: true, from: r.from, to: r.to });
  });

  // A manager or the owner makes a broker a team lead (on: true) or takes the role back (on: false); taking it back
  // clears the team under them. Same service as the website's "Make team lead" (web/routes/team.js).
  api.post("/team/:id/team-role", async (req, res) => {
    const m = req.session.broker;
    if (!UUID.test(req.params.id)) return fail(res, "not_found");
    const r = await Team.setTeamLeadRole(pool, m, req.params.id, req.body?.on === true || req.body?.on === "1");
    if (r.error) return fail(res, r.error);
    logOperation(pool, { agency_id: m.agency_id, broker_id: m.id, operation_type: "team_lead_role", metadata: { broker_id: r.broker.id, from: r.from, to: r.to } });
    return res.json({ ok: true, from: r.from, to: r.to });
  });

  // A manager puts a broker under a team lead (teamLeadId) or takes them out of any team (teamLeadId null).
  api.post("/team/:id/team", async (req, res) => {
    if (!UUID.test(req.params.id)) return fail(res, "not_found");
    const lead = req.body?.teamLeadId;
    const r = await Team.setTeam(pool, req.session.broker, req.params.id, lead && UUID.test(String(lead)) ? String(lead) : null);
    return r.error ? fail(res, r.error) : res.json({ ok: true });
  });

  api.post("/team/:id/deactivate", async (req, res) => {
    const r = await Team.deactivate(pool, req.session.broker, req.params.id);
    return r.error ? fail(res, r.error) : res.json({ ok: true });
  });

  // Undo of a deactivation: the broker is active again and gets back the leads it released (never ones reassigned since).
  api.post("/team/:id/undo-deactivate", async (req, res) => {
    const r = await Team.undoDeactivate(pool, req.session.broker, req.params.id);
    return r.error ? fail(res, r.error) : res.json({ ok: true, restored: r.restored });
  });

  api.post("/team/:id/reactivate", async (req, res) => {
    const r = await Team.reactivate(pool, req.session.broker, req.params.id);
    return r.error ? fail(res, r.error) : res.json({ ok: true });
  });

  // Permanent delete of a deactivated member. Audited first: if the audit cannot be written, nothing is deleted.
  api.post("/team/:id/delete", async (req, res) => {
    const m = req.session.broker;
    try {
      await Audit.recordStrict(pool, { agencyId: m.agency_id, brokerId: m.id, action: "team_member_delete", targetType: "broker", targetId: req.params.id, payload: {} });
    } catch {
      return res.status(503).json({ error: "audit" });
    }
    const r = await Team.remove(pool, m, req.params.id);
    return r.error ? fail(res, r.error) : res.json({ ok: true });
  });
}

module.exports = { register };
