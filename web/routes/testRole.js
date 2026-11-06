// web/routes/testRole.js — The test switch's actions: the test number changes its own role in the test agency, or
// switches to view the other agency read-only (and back). Anyone else, or any other agency, gets a 403.
// Role changes apply to the website and Telegram at once (same row).
"use strict";

const TestRole = require("../../lib/testRole");
const { logOperation } = require("../../lib/db");

function register(web, { pool }) {
  web.post("/test-role", async (req, res) => {
    const broker = req.session.broker;
    if (!TestRole.canSwitch(broker)) return res.status(403).type("text/plain").send("Not available");
    const role = String(req.body.role || "");
    if (!TestRole.ROLES.includes(role)) return res.status(422).type("text/plain").send("Unknown role");
    // The test number's own row, in its own (test) agency, even while it views another agency.
    const home = TestRole.homeAgencyOf(broker);
    const from = broker.home_role || broker.role;
    await pool.query("UPDATE brokers SET role = $2 WHERE id = $1 AND agency_id = $3", [broker.id, role, home]);
    logOperation(pool, { agency_id: home, broker_id: broker.id, operation_type: "test_role_switch", metadata: { from, to: role } });
    return res.redirect(303, "/app/");
  });

  // Switch between the test agency and the other agency (read-only). Only a session flag changes; no data is written.
  web.post("/test-view", (req, res) => {
    const broker = req.session.broker;
    if (!TestRole.canSwitch(broker)) return res.status(403).type("text/plain").send("Not available");
    const on = req.body.view === "other" && TestRole.canView(broker);
    TestRole.setViewing(req.sid, on);
    return res.redirect(303, "/app/");
  });
}

module.exports = { register };
