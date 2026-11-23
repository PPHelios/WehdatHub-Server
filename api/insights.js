// api/insights.js — Dashboard, prices per m², win and loss and "Report a problem" for the app. Same services as the website pages.
"use strict";

const Dash = require("../services/dashboards");
const Insights = require("../services/priceInsights");
const WinLoss = require("../services/winLoss");
const ErrorReports = require("../lib/errorReports");

function register(api, { pool }) {
  api.get("/dashboard", async (req, res) => {
    const brokerId = String(req.query.broker || "") || null;
    const teamLeadId = String(req.query.team || "") || null;
    const d = await Dash.agencyDashboard(pool, req.session.broker, { days: req.query.days, brokerId, teamLeadId });
    if (!d) return res.status(403).json({ error: "forbidden" });
    if (req.query.strictScope === "1" &&
        ((brokerId && d.brokerId !== brokerId) || (teamLeadId && d.teamLeadId !== teamLeadId))) {
      return res.status(422).json({ error: "invalid_scope" });
    }
    return res.json(d);
  });

  api.get("/insights/prices", async (req, res) => res.json({ minUnits: Insights.MIN_UNITS, items: await Insights.byPlace(pool, req.session.broker.agency_id) }));

  api.get("/insights/winloss", async (req, res) => {
    const r = await WinLoss.report(pool, req.session.broker, { days: req.query.days });
    return r ? res.json(r) : res.status(403).json({ error: "forbidden" });
  });

  api.post("/report", async (req, res) => {
    const text = String(req.body?.text || "").trim();
    if (text.length < 3) return res.status(422).json({ error: "text" });
    const r = await ErrorReports.submitReport(pool, req.session.broker, { text, channel: "app", path: null, userAgent: req.get("user-agent"), device: req.body?.device && typeof req.body.device === "object" ? req.body.device : null, type: String(req.body?.type || "bug") });
    return r.limited ? res.status(429).json({ error: "rate_limited" }) : res.json({ ok: true, id: r.id });
  });
}

module.exports = { register };
