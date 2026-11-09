// api/team.js — The team view for the app: managers see every active broker, a team lead sees their own team (and themselves),
// each with their open leads, overdue follow-ups and what is due today. Counts only cover leads this person may see
// (lib/visibility). Brokers get 403. Reassigning goes through POST /leads/:ref/assign (services/leads.js decides who may).
"use strict";

const Authz = require("../lib/authz");
const Vis = require("../lib/visibility");

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
}

module.exports = { register };
