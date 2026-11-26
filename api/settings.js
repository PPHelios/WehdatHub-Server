// api/settings.js — The person's own app settings (quiet line) and, for the agency owner, the two switches
// (brokers may edit units; data entry sees owners). Same services as the website's Settings and Owners pages.
"use strict";

const Authz = require("../lib/authz");
const Rights = require("../services/unitRights");
const UnitOwners = require("../services/unitOwners");
const LeadScope = require("../services/leadScope");
const Team = require("../services/team");
const AgencyLogo = require("../services/agencyLogo");
const { uploads } = require("../web/uploads");

function register(api, { pool }) {
  api.get("/settings", async (req, res) => {
    const b = req.session.broker;
    const { rows } = await pool.query("SELECT quiet_line FROM brokers WHERE id = $1 AND agency_id = $2", [b.id, b.agency_id]);
    const owner = Authz.isAgencyOwner(b);
    const manager = Authz.isManager(b);
    const agencyFlags = manager
      ? (await pool.query("SELECT data_entry_missing_photos, data_entry_overdue_units FROM agencies WHERE id = $1", [b.agency_id])).rows[0]
      : null;
    res.json({
      quietLine: rows[0]?.quiet_line !== false,
      switches: manager ? {
        dataEntryMissingPhotos: agencyFlags?.data_entry_missing_photos !== false,
        dataEntryOverdueUnits: agencyFlags?.data_entry_overdue_units !== false,
        ...(owner ? {
          brokersMayWrite: await Rights.brokersMayWrite(pool, b.agency_id),
          dataEntryOwners: await UnitOwners.dataEntryOwnersOn(pool, b.agency_id),
          brokersSeeAllLeads: await LeadScope.brokersSeeAll(pool, b.agency_id),
          ...(b.workspace?.tier === "team" && b.workspace.members > 1 ? {
            brokersWorkSharedLeads: Boolean(b.workspace.brokersWorkSharedLeads),
            brokersEditColleagueUnits: Boolean(b.workspace.brokersEditColleagueUnits)
          } : {})
        } : {})
      } : null
    });
  });
  api.post("/settings", async (req, res) => {
    const b = req.session.broker;
    const body = req.body || {};
    if (typeof body.quietLine === "boolean") await pool.query("UPDATE brokers SET quiet_line = $3 WHERE id = $1 AND agency_id = $2", [b.id, b.agency_id, body.quietLine]);
    if (body.switches) {
      const s = body.switches;
      const hasOwnerSwitch = ["brokersSeeAllLeads", "brokersWorkSharedLeads", "brokersEditColleagueUnits", "brokersMayWrite", "dataEntryOwners"].some((k) => typeof s[k] === "boolean");
      if (!Authz.isManager(b) || (hasOwnerSwitch && !Authz.isAgencyOwner(b))) return res.status(403).json({ error: "forbidden" });
      const { brokersSeeAllLeads, brokersWorkSharedLeads, brokersEditColleagueUnits, dataEntryMissingPhotos, dataEntryOverdueUnits } = s;
      if (typeof dataEntryMissingPhotos === "boolean" || typeof dataEntryOverdueUnits === "boolean") {
        await pool.query(
          `UPDATE agencies SET
             data_entry_missing_photos = COALESCE($2, data_entry_missing_photos),
             data_entry_overdue_units = COALESCE($3, data_entry_overdue_units)
           WHERE id = $1`,
          [b.agency_id, typeof dataEntryMissingPhotos === "boolean" ? dataEntryMissingPhotos : null, typeof dataEntryOverdueUnits === "boolean" ? dataEntryOverdueUnits : null]
        );
      }
      if (typeof brokersWorkSharedLeads === "boolean" || typeof brokersEditColleagueUnits === "boolean") {
        const result = await Team.setCollaboration(pool, b, { brokersWorkSharedLeads, brokersEditColleagueUnits });
        if (result.error) return res.status(403).json({ error: result.error });
      }
      if (typeof brokersSeeAllLeads === "boolean") await LeadScope.setBrokersSeeAll(pool, b, brokersSeeAllLeads);
      if (typeof s.brokersMayWrite === "boolean") await Rights.setBrokersMayWrite(pool, b, s.brokersMayWrite);
      if (typeof s.dataEntryOwners === "boolean") await UnitOwners.setDataEntryOwners(pool, b, s.dataEntryOwners);
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
