// tests/web/audit-log.test.js — The audit log (patch 2): protected rows, 12-month cleanup, sensitive actions refused when the log
// is down, changes logged with IP and device, the filtered Activity Log page, and the new owner alerts.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Audit = require("../../services/audit");
const Privacy = require("../../services/unitPrivacy");
const Alerts = require("../../services/systemAlerts");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = (action, extra = "") => h.query(`INSERT INTO audit_logs (agency_id, broker_id, action ${extra ? ", created_at" : ""}) VALUES ($1, $2, $3 ${extra ? ", " + extra : ""}) RETURNING id`, [h.BROKERS.admin.agency_id, h.BROKERS.admin.id, action]);

test("audit rows cannot be edited or deleted before 12 months, and the cleanup removes older ones", async () => {
  const [fresh] = await row("test_fresh");
  await expect(h.query("UPDATE audit_logs SET action = 'x' WHERE id = $1", [fresh.id])).rejects.toThrow(/cannot be changed/);
  await expect(h.query("DELETE FROM audit_logs WHERE id = $1", [fresh.id])).rejects.toThrow(/kept for 12 months/);
  const [old] = await row("test_old", "NOW() - INTERVAL '13 months'");
  const out = await Audit.cleanup(h.pool);
  expect(out.removed).toBeGreaterThanOrEqual(1);
  expect((await h.query("SELECT 1 FROM audit_logs WHERE id = $1", [old.id])).length).toBe(0);
  expect((await h.query("SELECT 1 FROM audit_logs WHERE id = $1", [fresh.id])).length).toBe(1);
});

test("a sensitive action is refused when the audit log cannot be written", async () => {
  await h.seedBroker("owner");
  await h.query("ALTER TABLE audit_logs RENAME TO audit_logs_down");
  try {
    await expect(Audit.recordStrict(h.pool, { agencyId: h.BROKERS.admin.agency_id, action: "x" })).rejects.toThrow("audit_unavailable");
    await expect(Privacy.setScope(h.pool, h.BROKERS.owner, "all")).rejects.toThrow("audit_unavailable");
    const admin = await signIn(h, "admin");
    const res = await admin.agent.post("/app/settings/quiet-line").type("form").send({ _csrf: admin.csrf });
    expect(res.status).toBe(503);
  } finally {
    await h.query("ALTER TABLE audit_logs_down RENAME TO audit_logs");
  }
});

test("a change under settings is logged first with the person, the path and the device", async () => {
  const admin = await signIn(h, "admin");
  await admin.agent.post("/app/settings/quiet-line").set("User-Agent", "TestPhone/1").type("form").send({ _csrf: admin.csrf });
  const rows = await h.query("SELECT * FROM audit_logs WHERE action LIKE 'web POST /settings%'");
  expect(rows.length).toBe(1);
  expect(rows[0].broker_id).toBe(h.BROKERS.admin.id);
  expect(rows[0].user_agent).toBe("TestPhone/1");
  expect(rows[0].ip).toBeTruthy();
});

test("the Activity Log page lists audit rows and filters by action", async () => {
  await row("web POST /catalogue/projects/:id/phases/:id/delete");
  await row("secret_details_request");
  await h.seedBroker("owner");
  const owner = await signIn(h, "owner");
  const all = (await owner.agent.get("/app/activity-log")).text;
  expect(all).toContain("phases/:id/delete");
  const filtered = (await owner.agent.get("/app/activity-log?action=catalogue")).text;
  expect(filtered).toContain("phases/:id/delete");
  expect(filtered).not.toContain("private details");
});

test("owner alerts: daily AI spend, failed sign-ins and repeated exports", async () => {
  await h.query("INSERT INTO operation_logs (agency_id, broker_id, operation_type, model_used, estimated_cost_usd) VALUES ($1, $2, 'ai_test', 'm', 9)", [h.BROKERS.admin.agency_id, h.BROKERS.admin.id]);
  for (let i = 0; i < 10; i++) await row("web_login_code failed");
  for (let i = 0; i < 3; i++) await row("command_inventory_export");
  const keys = (await Alerts.due(h.pool)).map((a) => a.key);
  expect(keys.some((k) => k.startsWith("ai_spend:"))).toBe(true);
  expect(keys).toContain("failed_signins");
  expect(keys.some((k) => k.startsWith("exports:"))).toBe(true);
});
