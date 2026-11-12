// api/team.js — The team view for the app: managers see every active broker, a team lead sees their own team (and themselves),
// each with their open leads, overdue follow-ups and what is due today. Counts only cover leads this person may see
// (lib/visibility). Brokers get 403. Reassigning goes through POST /leads/:ref/assign (services/leads.js decides who may).
"use strict";

const Authz = require("../lib/authz");
const Vis = require("../lib/visibility");
const LeadRules = require("../services/leadRules");

function register(api, { pool }) {
  api.get("/team", async (req, res) => {
    const { broker } = req.session;
    const manager = Authz.isManager(broker);
    if (!manager && !Authz.isTeamLead(broker)) return res.status(403).json({ error: "forbidden" });
    const members = (
      await pool.query(
        `SELECT id, name, role, away_until FROM brokers
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
    return res.json({
      items: members.map((m) => {
        const c = counts.get(m.id) || {};
        const away = m.away_until && new Date(m.away_until) > new Date();
        return { id: m.id, name: m.name, role: m.role, me: m.id === broker.id, away: Boolean(away), open: c.open || 0, overdue: c.overdue || 0, soon: c.soon || 0 };
      })
    });
  });

  // Managers: the lead rules, the round-robin order and the brokers in it (same services as the website's Team page).
  const fail = (res, r) => res.status(r.error === "forbidden" ? 403 : r.error === "not_found" ? 404 : 422).json({ error: r.error, field: r.field || null });
  api.get("/team/rules", async (req, res) => {
    const { broker } = req.session;
    if (!Authz.isManager(broker)) return res.status(403).json({ error: "forbidden" });
    const [rules, list] = await Promise.all([LeadRules.getRules(pool, broker.agency_id), LeadRules.routingList(pool, broker.agency_id)]);
    res.json({ rules, roundRobin: list.routing.round_robin, order: list.routing.order, brokers: list.brokers.map((b) => ({ id: b.id, name: b.name, role: b.role, away: Boolean(b.away_until && new Date(b.away_until) > new Date()), open: b.open_leads })) });
  });
  api.post("/team/rules", async (req, res) => {
    const r = await LeadRules.saveRules(pool, req.session.broker, req.body || {});
    return r.error ? fail(res, r) : res.json({ rules: r.rules });
  });
  api.post("/team/routing", async (req, res) => {
    const b = req.body || {};
    const r = await LeadRules.saveRouting(pool, req.session.broker, { roundRobin: b.roundRobin === true || b.roundRobin === "on", order: b.order });
    return r.error ? fail(res, r) : res.json({ roundRobin: r.routing.round_robin, order: r.routing.order });
  });
  api.post("/team/:id/away", async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: "not_found" });
    const r = await LeadRules.setAway(pool, req.session.broker, req.params.id, String(req.body?.until || "").trim() || null);
    return r.error ? fail(res, r) : res.json({ id: req.params.id, awayUntil: r.broker.away_until ? new Date(r.broker.away_until).toISOString() : null });
  });
}

module.exports = { register };
