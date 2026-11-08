// api/today.js — The broker's day for the app: the same read as the website's Today page and the daily digest
// (services/dailyDigest.js briefData: the broker's own leads, behind lib/visibility), arranged as a list of tasks.
"use strict";

const Digest = require("../services/dailyDigest");
const { refLabel } = require("../domain/leadCard");

const MAX_TASKS = 20;
const digits = (p) => String(p || "").replace(/[^0-9]/g, "");

function tasksOf(d) {
  const seen = new Set();
  const out = [];
  const add = (r, kind, extra = {}) => {
    if (!r || seen.has(r.ref)) return;
    seen.add(r.ref);
    out.push({ ref: refLabel(r.ref), name: r.name || null, kind, at: r.next_follow_up_at || null, unitCode: r.unit_code || null, phone: digits(r.phone_e164) || null, matches: r.n || null, ...extra });
  };
  for (const r of d.overdue) add(r, "late");
  for (const r of d.viewings) add(r, "viewing");
  for (const r of d.hot) add(r, "hot");
  for (const r of d.calls) add(r, "call");
  for (const r of d.matches) add(r, "matches");
  return out;
}

function register(api, { pool }) {
  api.get("/today", async (req, res) => {
    const d = await Digest.briefData(pool, req.session.broker, new Date());
    const tasks = tasksOf(d);
    return res.json({
      counts: { followUpsToday: d.calls.length + d.viewings.length, viewings: d.viewings.length, newLeads: d.uncontacted },
      tasks: tasks.slice(0, MAX_TASKS),
      moreTasks: Math.max(0, tasks.length - MAX_TASKS)
    });
  });
}

module.exports = { register, tasksOf };
