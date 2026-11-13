// api/settings.js — The person's own app settings (draft style, quiet line) and, for the agency owner, the two switches
// (brokers may edit units; data entry sees owners). Same services as the website's Settings and Owners pages.
"use strict";

const Authz = require("../lib/authz");
const Rights = require("../services/unitRights");
const UnitOwners = require("../services/unitOwners");
const FollowUpDrafts = require("../services/followUpDrafts");
const AgencyLogo = require("../services/agencyLogo");
const { uploads } = require("../web/uploads");

function register(api, { pool }) {
  api.get("/settings", async (req, res) => {
    const b = req.session.broker;
    const { rows } = await pool.query("SELECT draft_style, quiet_line FROM brokers WHERE id = $1 AND agency_id = $2", [b.id, b.agency_id]);
    const owner = Authz.isAgencyOwner(b);
    res.json({
      draftStyle: rows[0]?.draft_style || "",
      quietLine: rows[0]?.quiet_line !== false,
      switches: owner ? { brokersMayWrite: await Rights.brokersMayWrite(pool, b.agency_id), dataEntryOwners: await UnitOwners.dataEntryOwnersOn(pool, b.agency_id) } : null
    });
  });
  api.post("/settings", async (req, res) => {
    const b = req.session.broker;
    const body = req.body || {};
    if (typeof body.quietLine === "boolean") await pool.query("UPDATE brokers SET quiet_line = $3 WHERE id = $1 AND agency_id = $2", [b.id, b.agency_id, body.quietLine]);
    if (typeof body.draftStyle === "string") await FollowUpDrafts.saveStyle(pool, b, body.draftStyle);
    if (body.switches) {
      if (!Authz.isAgencyOwner(b)) return res.status(403).json({ error: "forbidden" });
      if (typeof body.switches.brokersMayWrite === "boolean") await Rights.setBrokersMayWrite(pool, b, body.switches.brokersMayWrite);
      if (typeof body.switches.dataEntryOwners === "boolean") await UnitOwners.setDataEntryOwners(pool, b, body.switches.dataEntryOwners);
    }
    res.json({ ok: true });
  });
}

// Logo (managers, the agency owner, admins): a picture up to 2 MB, or remove it. Same service as the website's Settings.
function registerLogo(api, { pool }) {
  api.post("/settings/logo", uploads([{ name: "logo", maxCount: 1, accept: /^image\/(png|jpeg|webp)$/ }], { maxMb: 2 }), async (req, res) => {
    const out = await AgencyLogo.setLogo(pool, req.session.broker, (req.files?.logo || [])[0]);
    if (out.error) return res.status(out.error === "forbidden" ? 403 : 422).json({ error: out.error });
    return res.json({ ok: true, url: out.url });
  });
  api.post("/settings/logo/remove", async (req, res) => {
    const out = await AgencyLogo.removeLogo(pool, req.session.broker);
    return out.error ? res.status(403).json({ error: out.error }) : res.json({ ok: true });
  });
}

module.exports = { register: (api, deps) => { register(api, deps); registerLogo(api, deps); } };
