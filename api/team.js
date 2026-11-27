// api/team.js — The team view for the app: managers see every active broker, a team lead sees their own team (and themselves),
// each with their open leads, overdue follow-ups and what is due today. Counts only cover leads this person may see
// (lib/visibility). Brokers get 403. Reassigning goes through POST /leads/:ref/assign (services/leads.js decides who may).
"use strict";

const Authz = require("../lib/authz");
const LeadRules = require("../services/leadRules");
const Leads = require("../services/leads");
const Team = require("../services/team");

function register(api, { pool }) {
  api.get("/team", async (req, res) => {
    const { broker } = req.session;
    const manager = Authz.isManager(broker);
    if (!manager && !Authz.isTeamLead(broker)) return res.status(403).json({ error: "forbidden" });
    return res.json({ items: await Team.teamBoard(pool, broker) });
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
  // A manager (or a team lead, for their own team) nudges one broker about their waiting / overdue / no-next-step leads.
  api.post("/brokers/:id/nudge", async (req, res) => {
    const r = await Leads.nudgeBroker(pool, req.session.broker, req.params.id);
    if (r.retryAfterSec) res.set("Retry-After", String(r.retryAfterSec));
    if (r.error) return res.status(r.error === "forbidden" ? 403 : r.error === "not_found" ? 404 : r.error === "too_many" ? 429 : 422).json({ error: r.error === "too_many" ? "rate_limited" : r.error });
    return res.status(204).end();
  });
}

module.exports = { register };
