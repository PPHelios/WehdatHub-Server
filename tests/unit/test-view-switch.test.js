// tests/unit/test-view-switch.test.js — the test number may view the other agency read-only; nothing else changes
"use strict";

const TestRole = require("../../lib/testRole");
const ViewGuard = require("../../lib/viewGuard");

const env = { TEST_SWITCH_PHONE: "01119998044", TEST_SWITCH_AGENCY_ID: "agency-test-1", TEST_SWITCH_VIEW_AGENCY_ID: "agency-nch" };
const me = { agency_id: "agency-test-1", phone_normalized: "201119998044", role: "owner" };

test("the test number can view the other agency only when it is configured", () => {
  expect(TestRole.canView(me, env)).toBe(true);
  expect(TestRole.canView(me, { ...env, TEST_SWITCH_VIEW_AGENCY_ID: "" })).toBe(false);
  expect(TestRole.canView(me, { ...env, TEST_SWITCH_VIEW_AGENCY_ID: "agency-test-1" })).toBe(false);
});

test("nobody else can view: another number, another agency, or the CRM admin number", () => {
  expect(TestRole.canView({ ...me, phone_normalized: "201000000001" }, env)).toBe(false);
  expect(TestRole.canView({ ...me, agency_id: "agency-real" }, env)).toBe(false);
  expect(TestRole.canView({ ...me, phone_normalized: "201055881114" }, { ...env, TEST_SWITCH_PHONE: "01055881114" })).toBe(false);
});

test("the viewer is the other agency, the owner shows as manager, and the home agency is kept", () => {
  const v = TestRole.asViewer(me, env);
  expect(v.agency_id).toBe("agency-nch");
  expect(v.view_of).toBe("agency-test-1");
  expect(v.role).toBe("manager");
  expect(TestRole.canSwitch(v, env)).toBe(true);
  expect(TestRole.canView(v, env)).toBe(true);
  expect(TestRole.asViewer({ ...me, role: "broker" }, env).role).toBe("broker");
});

test("the role switch still changes the test number\'s own row while viewing", () => {
  const v = TestRole.asViewer({ ...me, role: "data_entry" }, env);
  expect(TestRole.homeAgencyOf(v)).toBe("agency-test-1");
  expect(v.home_role).toBe("data_entry");
});

test("the viewing flag is per session and can be switched off", () => {
  TestRole.setViewing("sid-1", true);
  expect(TestRole.isViewing("sid-1")).toBe(true);
  expect(TestRole.isViewing("sid-2")).toBe(false);
  TestRole.setViewing("sid-1", false);
  expect(TestRole.isViewing("sid-1")).toBe(false);
});

test("while viewing, only plain reads pass the guard", () => {
  expect(ViewGuard.isReadOnlySql("SELECT id FROM listings WHERE agency_id = $1")).toBe(true);
  expect(ViewGuard.isReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(true);
  expect(ViewGuard.isReadOnlySql("UPDATE brokers SET role = $2")).toBe(false);
  expect(ViewGuard.isReadOnlySql("INSERT INTO operation_logs (id) VALUES (1)")).toBe(false);
  expect(ViewGuard.isReadOnlySql("DELETE FROM leads")).toBe(false);
  expect(ViewGuard.isReadOnlySql("SELECT nextval('seq')")).toBe(false);
  expect(ViewGuard.isReadOnlySql("WITH d AS (DELETE FROM leads RETURNING 1) SELECT * FROM d")).toBe(false);
  expect(ViewGuard.isReadOnlySql(null)).toBe(false);
});

test("the guard blocks writes inside a view request and allows them outside", async () => {
  const pool = { query: async () => ({ rows: [] }), connect: async () => ({ query: async () => ({ rows: [] }) }) };
  ViewGuard.guardPool(pool);
  await expect(ViewGuard.runReadOnly(() => pool.query("UPDATE brokers SET role = 'x'"))).rejects.toThrow("Read only");
  await expect(ViewGuard.runReadOnly(() => pool.query("SELECT 1"))).resolves.toEqual({ rows: [] });
  await expect(pool.query("UPDATE brokers SET role = 'x'")).resolves.toEqual({ rows: [] });
  const client = await pool.connect();
  await expect(ViewGuard.runReadOnly(() => client.query("DELETE FROM leads"))).rejects.toThrow("Read only");
});

test("rate limits are not written while viewing (read-only); they still count normally outside", async () => {
  const RateLimit = require("../../lib/rateLimit");
  // The limiter sweeps old rows on 2% of hits; pin the dice so the count of queries is exact.
  jest.spyOn(Math, "random").mockReturnValue(0.5);
  const calls = [];
  const pool = { query: async (sql) => { calls.push(sql); return { rows: [{ hits: 1 }] }; } };
  const viewed = await ViewGuard.runReadOnly(() => RateLimit.hit(pool, "search:x", { limit: 5, windowSec: 60 }));
  expect(viewed.allowed).toBe(true);
  expect(calls.length).toBe(0);
  const normal = await RateLimit.hit(pool, "search:x", { limit: 5, windowSec: 60 });
  expect(normal.allowed).toBe(true);
  expect(calls.length).toBe(1);
  Math.random.mockRestore();
});
