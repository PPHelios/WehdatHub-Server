// api/today.js — Today for the app: the same result as the website's Today page (services/today.js), so both show the same things.
"use strict";

const Today = require("../services/today");

function register(api, { pool }) {
  api.get("/today", async (req, res) => res.json(await Today.build(pool, req.session.broker, new Date())));
}

module.exports = { register, tasksOf: Today.tasksOf };
