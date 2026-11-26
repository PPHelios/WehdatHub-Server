// api/today.js — Today for the app: the same result as the website's Today page (services/today.js), so both show the same things.
"use strict";

const Today = require("../services/today");
const ReadCaps = require("../lib/readCaps");
const { onboardingOf } = require("./auth");

function register(api, { pool }) {
  api.get("/today/home", async (req, res) => {
    const [home, onboarding] = await Promise.all([
      Today.home(pool, req.session.broker),
      onboardingOf(pool, req.session.broker)
    ]);
    return res.json({ ...home, onboarding });
  });
  api.get("/today/overdue-units", async (req, res) => {
    const { broker } = req.session;
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    if (offset > ReadCaps.maxOffset(broker, 100000)) return res.status(403).json({ error: "too_deep" });
    const page = await Today.overduePage(pool, broker, offset);
    const cap = await ReadCaps.takeListRows(pool, broker, "units", page.items.length);
    if (!cap.allowed) return res.set("Retry-After", String(cap.retryAfterSec)).status(429).json({ error: "daily_cap" });
    return res.json(page);
  });
  api.get("/today", async (req, res) => res.json(await Today.build(pool, req.session.broker, new Date())));
}

module.exports = { register, tasksOf: Today.tasksOf };
