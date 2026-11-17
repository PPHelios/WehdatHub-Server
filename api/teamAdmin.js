// api/teamAdmin.js — Team changes for the app: invite, change a role (agency owner), deactivate. Same services and rules as the
// website (services/team.js). Only the agency owner adds managers or changes roles.
"use strict";

const Team = require("../services/team");
const Audit = require("../services/audit");

const STATUS = { forbidden: 403, not_found: 404, rank: 403, phone_taken: 409, seats: 402, self: 409, active: 409, has_records: 409 };
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

  api.post("/team/:id/deactivate", async (req, res) => {
    const r = await Team.deactivate(pool, req.session.broker, req.params.id);
    return r.error ? fail(res, r.error) : res.json({ ok: true });
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
