// tests/unit/test-role-switch.test.js — the test switch is only for the test number inside the test agency (by ID)
"use strict";

const TestRole = require("../../lib/testRole");

const env = { TEST_SWITCH_PHONE: "01119998044", TEST_SWITCH_AGENCY_ID: "agency-test-1" };
const me = { agency_id: "agency-test-1", phone_normalized: "201119998044", role: "owner" };

test("the test number in the test agency can switch", () => {
  expect(TestRole.canSwitch(me, env)).toBe(true);
});

test("nobody else can switch: another number, another agency, or the CRM admin number", () => {
  expect(TestRole.canSwitch({ ...me, phone_normalized: "201000000001" }, env)).toBe(false);
  expect(TestRole.canSwitch({ ...me, agency_id: "agency-real" }, env)).toBe(false);
  expect(TestRole.canSwitch({ ...me, phone_normalized: "201055881114" }, { ...env, TEST_SWITCH_PHONE: "01055881114" })).toBe(false);
});

test("several test numbers can switch when TEST_SWITCH_PHONE is a comma list", () => {
  const multi = { ...env, TEST_SWITCH_PHONE: "01119998044,01119998045" };
  expect(TestRole.canSwitch(me, multi)).toBe(true);
  expect(TestRole.canSwitch({ ...me, phone_normalized: "201119998045" }, multi)).toBe(true);
  expect(TestRole.canSwitch({ ...me, phone_normalized: "201000000001" }, multi)).toBe(false);
});

test("off unless both settings are present", () => {
  expect(TestRole.canSwitch(me, { TEST_SWITCH_PHONE: env.TEST_SWITCH_PHONE })).toBe(false);
  expect(TestRole.canSwitch(me, { TEST_SWITCH_AGENCY_ID: env.TEST_SWITCH_AGENCY_ID })).toBe(false);
  expect(TestRole.canSwitch(me, {})).toBe(false);
});

test("only the four views can be chosen", () => {
  expect(TestRole.ROLES).toEqual(["owner", "manager", "team_lead", "broker", "data_entry"]);
});
