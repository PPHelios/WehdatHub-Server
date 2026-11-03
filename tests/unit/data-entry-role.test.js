// tests/unit/data-entry-role.test.js — the data entry role: edits any unit that is not VIP, no deals, no leads, and only
// the bot commands data entry needs (lib/authz.js and the command matcher in lib/registry.js)
"use strict";

const Authz = require("../../lib/authz");
const R = require("../../lib/registry");

const de = { id: "d1", agency_id: "A", role: "data_entry" };

test("data entry: edits any unit in the agency that is not VIP", () => {
  expect(Authz.canEdit(de, { agency_id: "A", broker_id: "someone-else", is_private: false })).toBe(true);
  expect(Authz.canEdit(de, { agency_id: "A", broker_id: "d1", is_private: false })).toBe(true);
  expect(Authz.canEdit(de, { agency_id: "A", broker_id: "someone-else", is_private: true })).toBe(false);
  expect(Authz.canEdit(de, { agency_id: "B", broker_id: "someone-else", is_private: false })).toBe(false);
});

test("data entry: is not a manager, owner or team lead, and sees no deals", () => {
  expect(Authz.isManager(de)).toBe(false);
  expect(Authz.isAgencyOwner(de)).toBe(false);
  expect(Authz.isTeamLead(de)).toBe(false);
  expect(Authz.isDataEntry(de)).toBe(true);
  const deal = { agency_id: "A", closing_broker_id: "d1", shares: [] };
  expect(Authz.canViewDeal(de, deal)).toBe(false);
  expect(Authz.canEditDeal(de, deal)).toBe(false);
  expect(Authz.canManageLeads(de)).toBe(false);
});

test("data entry: only the commands it needs reach the matcher", () => {
  const hitName = (text) => (R.find(text, {}, { dataEntry: true }) || {}).command?.name;
  expect(hitName("سعر HP-201 9 مليون")).toBe("price");
  expect(hitName("صفقة HP-201 مع أحمد")).not.toBe("deal");
  expect(hitName("صفقة HP-201 مع أحمد")).not.toBe("lead");
});

test("other roles keep every command", () => {
  expect((R.find("صفقة HP-201 مع أحمد", {}, { dataEntry: false }) || {}).command?.name).toBe("deal");
});
