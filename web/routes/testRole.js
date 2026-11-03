// web/routes/testRole.js — The test switch's one action: the test number changes its own role in the test agency.
// Anyone else, or any other agency, gets a 403. Role changes apply to the website and Telegram at once (same row).
"use strict";

const TestRole = require("../../lib/testRole");
const { logOperation } = require("../../lib/db");

function register(web, { pool }) {
  web.post("/test-role", async (req, res) => {
    const broker = req.session.broker;
    if (!TestRole.canSwitch(broker)) return res.status(403).type("text/plain").send("Not available");
    const role = String(req.body.role || "");
    if (!TestRole.ROLES.includes(role)) return res.status(422).type("text/plain").send("Unknown role");
    await pool.query("UPDATE brokers SET role = $2 WHERE id = $1 AND agency_id = $3", [broker.id, role, broker.agency_id]);
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "test_role_switch", metadata: { from: broker.role, to: role } });
    return res.redirect(303, "/app/");
  });
}

module.exports = { register };
