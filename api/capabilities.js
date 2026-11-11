// api/capabilities.js — What the signed-in person may do, decided here (lib/authz) so the app carries no role rules of its own.
"use strict";

const Authz = require("../lib/authz");

function capabilitiesOf(b) {
  const manager = Authz.isManager(b);
  const owner = Authz.isAgencyOwner(b);
  return {
    role: String(b.role || "").toLowerCase(),
    manager,
    agencyOwner: owner,
    teamLead: Authz.isTeamLead(b),
    dataEntry: Authz.isDataEntry(b),
    platformOwner: Authz.isCrmOwner(b),
    can: {
      owners: !Authz.isDataEntry(b),
      moveUnitOwner: manager,
      deleteOwner: manager,
      accessRequests: manager,
      activityLog: manager,
      team: manager || Authz.isTeamLead(b),
      invite: manager,
      inviteManager: owner,
      changeRole: owner,
      markPrivate: owner,
      plan: owner
    }
  };
}

function register(api) {
  api.get("/capabilities", (req, res) => res.json(capabilitiesOf(req.session.broker)));
}

module.exports = { register, capabilitiesOf };
