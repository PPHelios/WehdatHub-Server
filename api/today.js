// api/today.js — Today for the app: the same result as the website's Today page (services/today.js), so both show the same things.
"use strict";

const Today = require("../services/today");

function register(api, { pool }) {
  api.get("/today", async (req, res) => res.json(await Today.build(pool, req.session.broker, new Date())));
  // A person hides a card (a lease reminder) from their own Today.
  api.post("/today/dismiss", async (req, res) => {
    const out = await Today.dismiss(pool, req.session.broker, String((req.body || {}).kind || ""), String((req.body || {}).key || ""));
    return out.error ? res.status(422).json(out) : res.json(out);
  });
}

module.exports = { register, tasksOf: Today.tasksOf };
