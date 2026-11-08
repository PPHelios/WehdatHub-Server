// api/devices.js — The app registers its phone for alerts (Firebase token) and removes it on sign-out. A token belongs to
// one broker at a time: signing in as someone else on the same phone moves it.
"use strict";

function register(api, { pool }) {
  api.post("/devices", async (req, res) => {
    const { broker } = req.session;
    const token = String((req.body || {}).token || "").trim();
    const platform = String((req.body || {}).platform || "");
    if (token.length < 20 || token.length > 4096 || !["android", "ios"].includes(platform)) return res.status(400).json({ error: "bad_request" });
    await pool.query(
      `INSERT INTO device_tokens (broker_id, agency_id, token, platform) VALUES ($1, $2, $3, $4)
       ON CONFLICT (token) DO UPDATE SET broker_id = EXCLUDED.broker_id, agency_id = EXCLUDED.agency_id, platform = EXCLUDED.platform, failed_count = 0`,
      [broker.id, broker.agency_id, token, platform]
    );
    return res.json({ ok: true });
  });

  api.post("/devices/remove", async (req, res) => {
    const { broker } = req.session;
    const token = String((req.body || {}).token || "").trim();
    if (token) await pool.query("DELETE FROM device_tokens WHERE token = $1 AND broker_id = $2", [token, broker.id]);
    return res.json({ ok: true });
  });
}

module.exports = { register };
