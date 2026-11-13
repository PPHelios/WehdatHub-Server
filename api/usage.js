// api/usage.js — The phone reports feature use and timings in batches. Always answers 204: it must never block the app.
"use strict";

const UsageLog = require("../lib/usageLog");

function register(api, { pool }) {
  const seen = new Map(); // broker id -> { hour, n }: 600 events an hour each, extra ones are dropped quietly
  api.post("/usage-events", async (req, res) => {
    const b = req.session.broker;
    const hour = Math.floor(Date.now() / 3600000);
    const s = seen.get(b.id) && seen.get(b.id).hour === hour ? seen.get(b.id) : { hour, n: 0 };
    seen.set(b.id, s);
    if (seen.size > 5000) seen.clear();
    const events = UsageLog.cleanBatch(req.body).slice(0, Math.max(0, 600 - s.n));
    s.n += events.length;
    try {
      await UsageLog.record(pool, { agencyId: b.agency_id, brokerId: b.id, channel: "app", events });
    } catch (_e) {
      /* never block the app */
    }
    res.status(204).end();
  });
}

module.exports = { register };
