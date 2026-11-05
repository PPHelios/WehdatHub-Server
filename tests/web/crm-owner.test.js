// tests/web/crm-owner.test.js — The CRM owner (OWNER_BROKER_IDS) is not part of any agency's work: their own bar, menu,
// settings and help; only app alerts reach them (error spike, failing AI calls, credits near the end, a waiting payment).
// Everyone else is unchanged.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const { resetConfig } = require("../../config");
const Alerts = require("../../services/systemAlerts");
const N = require("../../lib/notifications");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
  resetConfig();
});
afterAll(async () => {
  delete process.env.OWNER_BROKER_IDS;
  resetConfig();
  await closeHarness();
});

const barOf = (text) => (text.match(/<nav class="tabbar[^"]*"[\s\S]*?<\/nav>/) || [""])[0];

test("the CRM owner starts on their own home and has their own bar and menu", async () => {
  const crm = await signIn(h, "admin");
  const home = await crm.agent.get("/app/?lang=en");
  expect(home.status).toBe(200);
  expect(home.text).toMatch(/href="\/app\/owner"/);
  expect(home.text).toMatch(/href="\/app\/owner\/board"/);
  expect(home.text).toMatch(/Latest app alerts/);
  expect(home.text).not.toMatch(/Needs you now|Follow-ups today/);
  const bar = barOf((await crm.agent.get("/app/owner?lang=en")).text);
  expect(bar).toMatch(/Tracking/);
  expect(bar).toMatch(/Board/);
  expect(bar).toMatch(/Alerts/);
  expect(bar).toMatch(/Settings/);
  expect(bar).not.toMatch(/Leads|Units|Team|Today/);
  const more = (await crm.agent.get("/app/more?lang=en")).text;
  expect(more).toMatch(/App tracking/);
  expect(more).toMatch(/Notifications/);
  expect(more).not.toMatch(/Deals|Agency dashboard|Owners|Portal enquiries|Import/);
});

test("an agency broker still gets the agency bar and menu", async () => {
  const mgr = await signIn(h, "broker");
  const bar = barOf((await mgr.agent.get("/app/leads?lang=en")).text);
  expect(bar).toMatch(/Leads/);
  expect(bar).not.toMatch(/Tracking/);
  expect((await mgr.agent.get("/app/")).status).toBe(200);
});

test("settings for the CRM owner offer only app alerts, no logo and no client-message style", async () => {
  const crm = await signIn(h, "admin");
  const page = (await crm.agent.get("/app/settings?lang=en")).text;
  expect([...page.matchAll(/data-kind="([a-z_]+)"/g)].map((m) => m[1])).toEqual(["system_alert"]);
  expect(page).not.toMatch(/Agency logo|id="quiet-line"|id="draft-style"/);
  expect(N.kindsFor({ id: h.BROKERS.admin.id, role: "admin" })).toEqual(["system_alert"]);
  expect(N.kindsFor({ id: h.BROKERS.broker.id, role: "broker" })).not.toContain("system_alert");
});

test("the guide for the CRM owner is theirs: app owner section, no agency commands", async () => {
  const crm = await signIn(h, "admin");
  const guide = (await crm.agent.get("/app/guide?lang=en")).text;
  expect(guide).toContain('id="crm"');
  expect(guide).not.toContain('id="commands"');
  expect(guide).not.toContain('id="clients"');
});

describe("system alerts", () => {
  const owner = () => ({ id: h.BROKERS.admin.id });
  const alertRows = () => h.query("SELECT broker_id, kind, title FROM notifications WHERE kind = 'system_alert' ORDER BY id");

  test("an error spike alerts the CRM owner once per window, and only them", async () => {
    for (let i = 0; i < 30; i++) await h.query("INSERT INTO error_events (kind, source, fingerprint, message) VALUES ('error', 'web', $1, 'boom')", [`fp${i}`]);
    const first = await Alerts.run(h.pool);
    expect(first.alerts).toBeGreaterThan(0);
    const rows = await alertRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ broker_id: h.BROKERS.admin.id });
    expect(rows[0].title).toMatch(/30 errors in the last hour/);
    const again = await Alerts.run(h.pool);
    expect(again.sent).toBe(0);
    expect(await alertRows()).toHaveLength(1);
    expect(owner().id).toBe(h.BROKERS.admin.id);
  });

  test("a few errors, or a calm day, send nothing", async () => {
    for (let i = 0; i < 5; i++) await h.query("INSERT INTO error_events (kind, source, fingerprint, message) VALUES ('error', 'web', $1, 'boom')", [`fp${i}`]);
    expect((await Alerts.run(h.pool)).sent).toBe(0);
  });

  test("AI calls failing, and a payment waiting over a day", async () => {
    for (let i = 0; i < 12; i++) {
      await h.query("INSERT INTO operation_logs (agency_id, broker_id, operation_type, status, model_used) VALUES ($1, $2, 'search_parse', $3, 'gemini')", [h.AGENCY_A, h.BROKERS.broker.id, i < 6 ? "failed" : "success"]);
    }
    await h.query("INSERT INTO payments (agency_id, kind, plan, months, amount_egp, reference, status, created_at) VALUES ($1, 'plan', 'office', 1, 999, 'WH-OLD', 'pending', now() - interval '30 hours')", [h.AGENCY_A]);
    await h.query("INSERT INTO payments (agency_id, kind, plan, months, amount_egp, reference, status) VALUES ($1, 'plan', 'office', 1, 999, 'WH-NEW', 'pending')", [h.AGENCY_A]);
    const due = await Alerts.due(h.pool);
    expect(due.map((d) => d.key).sort()).toEqual(expect.arrayContaining(["ai_failures"]));
    expect(due.filter((d) => d.key.startsWith("payment:"))).toHaveLength(1);
    expect(due.find((d) => d.key === "ai_failures").title).toMatch(/6 of 12 AI calls failed/);
  });

  test("the thresholds are settings", async () => {
    process.env.SYSTEM_ALERT_ERRORS_PER_HOUR = "3";
    try {
      for (let i = 0; i < 5; i++) await h.query("INSERT INTO error_events (kind, source, fingerprint, message) VALUES ('error', 'web', $1, 'boom')", [`fp${i}`]);
      expect((await Alerts.due(h.pool)).map((d) => d.key)).toContain("errors");
    } finally {
      delete process.env.SYSTEM_ALERT_ERRORS_PER_HOUR;
    }
  });

  test("with no CRM owner configured, nothing is sent", async () => {
    delete process.env.OWNER_BROKER_IDS;
    resetConfig();
    for (let i = 0; i < 30; i++) await h.query("INSERT INTO error_events (kind, source, fingerprint, message) VALUES ('error', 'web', $1, 'boom')", [`fp${i}`]);
    expect(await Alerts.run(h.pool)).toEqual({ alerts: 0, sent: 0 });
  });
});
