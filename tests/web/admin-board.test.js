// tests/web/admin-board.test.js — The CRM owner's board: owner-only page, stored results with a last-updated time,
// the per-tab refresh cooldown, and fixed costs added and deleted from the Money tab.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const { resetConfig } = require("../../config");
const AdminBoard = require("../../services/adminBoard");

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

test("only the CRM owner opens the board; others get the ordinary 404", async () => {
  const crm = await signIn(h, "admin");
  const ok = await crm.agent.get("/app/owner/board");
  expect(ok.status).toBe(200);
  expect(ok.text).toContain('data-board="overview"');
  expect(ok.text).toContain("Not computed yet");

  const other = await signIn(h, "broker");
  expect((await other.agent.get("/app/owner/board")).status).toBe(404);
  expect((await other.agent.post("/app/owner/board/refresh").type("form").send({ tab: "overview", _csrf: other.csrf })).status).toBe(404);
});

test("a refresh stores every period of the tab with a last-updated time, then refuses a second refresh within 10 minutes", async () => {
  const crm = await signIn(h, "admin");
  const first = await crm.agent.post("/app/owner/board/refresh").type("form").send({ tab: "agencies", days: "30", _csrf: crm.csrf });
  expect(first.status).toBe(200);
  expect(first.text).toContain("Refreshed.");
  for (const days of AdminBoard.PERIODS) {
    const stored = await AdminBoard.readTab(h.pool, "agencies", days);
    expect(stored.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  }
  const page = await crm.agent.get("/app/owner/board?tab=agencies&days=30");
  expect(page.text).toContain("Last updated");

  const again = await crm.agent.post("/app/owner/board/refresh").type("form").send({ tab: "agencies", days: "30", _csrf: crm.csrf });
  expect(again.status).toBe(429);
  expect(again.text).toContain("Wait a bit");
});

test("a refresh of an unknown tab is refused without computing anything", async () => {
  const r = await AdminBoard.refreshTab(h.pool, "nope");
  expect(r).toEqual({ error: "unknown_tab" });
});

test("fixed costs are added and deleted from the Money tab, and the cash-flow figure follows", async () => {
  const crm = await signIn(h, "admin");
  const month = new Date().toISOString().slice(0, 7);
  const bad = await crm.agent.post("/app/owner/board/fixed-costs").type("form").send({ month: "2026-13", label: "Render", amount: "100", _csrf: crm.csrf });
  expect(bad.status).toBe(422);

  const added = await crm.agent.post("/app/owner/board/fixed-costs").type("form").send({ month, label: "Render", amount: "250", _csrf: crm.csrf });
  expect(added.status).toBe(200);
  expect(added.text).toContain("Render");

  const [row] = await AdminBoard.listFixedCosts(h.pool);
  expect(row.amount).toBe(250);
  const money = await AdminBoard.readTab(h.pool, "money", 30);
  expect(money.data.fixedEgp).toBe(250);
  expect(money.data.netEgp).toBe(round(money.data.paidInEgp - money.data.aiEgp - 250));

  const gone = await crm.agent.post(`/app/owner/board/fixed-costs/${row.id}/delete`).type("form").send({ _csrf: crm.csrf });
  expect(gone.status).toBe(200);
  expect(await AdminBoard.listFixedCosts(h.pool)).toHaveLength(0);
});

test("the nightly job computes every tab for every period", async () => {
  const job = AdminBoard.adminBoardJob();
  expect(job.name).toBe("admin_board_nightly");
  const out = await job.run({ pool: h.pool, now: new Date() });
  expect(out.counts.tabs).toBe(AdminBoard.TABS.length);
  const overview = await AdminBoard.readTab(h.pool, "overview", 7);
  expect(overview).not.toBeNull();
  expect(typeof overview.data.aiCalls).toBe("number");
});

test("trial cohorts count drop-off, first use, eligible day-seven activity, teammates and paid subscriptions", async () => {
  const now = new Date();
  const ago = (days) => new Date(now.getTime() - days * 86400000).toISOString();
  await h.seedBroker("broker");
  await h.query("UPDATE agencies SET plan = 'team' WHERE id = $1", [h.AGENCY_A]);
  await h.query(
    `INSERT INTO trial_funnel (signup_id, tier, offered_days, offered_credits, started_at, telegram_opened_at, verified_at, agency_id, granted_days, granted_credits)
     VALUES (1, 'team', 14, 200, $2, $2, $3, $1, 14, 200), (2, 'team', 14, 200, $3, NULL, NULL, NULL, NULL, NULL),
            (3, 'solo', 4, 80, $4, $4, $4, NULL, 4, 80)`,
    [h.AGENCY_A, ago(10), ago(9), ago(2)]
  );
  await h.query(
    `INSERT INTO usage_events (agency_id, broker_id, channel, event, ok, created_at) VALUES
       ($1, NULL, 'app', 'open_unit', true, $3),
       ($1, $2, 'app', 'search', true, $4),
       ($1, $2, 'app', 'search', false, $4),
       ($1, $2, 'app', 'search', true, $5)`,
    [h.AGENCY_A, h.BROKERS.broker.id, ago(8), ago(2.5), ago(0.5)]
  );
  await h.query(
    `INSERT INTO payments (agency_id, kind, plan, months, amount_egp, reference, status, confirmed_at) VALUES
       ($1, 'plan', 'team', 1, 599, 'WH-TRIAL-PAID', 'confirmed', $2),
       ($1, 'plan', 'team', 1, 599, 'WH-TRIAL-SECOND', 'confirmed', $2)`,
    [h.AGENCY_A, ago(1)]
  );
  await AdminBoard.computeTab(h.pool, "health", now);
  const { data } = await AdminBoard.readTab(h.pool, "health", 30);
  expect(data.trials.cohorts).toEqual([
    { tier: "solo", offered_days: 4, offered_credits: 80, started: 1, opened: 1, verified: 1, activated: 0, day7_eligible: 0, day7: 0, teammate: 0, paid: 0 },
    { tier: "team", offered_days: 14, offered_credits: 200, started: 2, opened: 1, verified: 1, activated: 1, day7_eligible: 1, day7: 1, teammate: 1, paid: 1 }
  ]);
  expect(data.trials.features).toContainEqual({ tier: "team", event: "search", agencies: 1, uses: 2, failed: 1 });
  const crm = await signIn(h, "admin");
  const page = await crm.agent.get("/app/owner/board?tab=health&days=30");
  expect(page.text).toContain("Trial funnel");
  expect(page.text).toContain("Feature use during the trial");
  expect(page.text).toContain("1 / 2 (50%)");
});

function round(n) {
  return Math.round(n * 100) / 100;
}

describe("five views, health and content (Phase 5)", () => {
  test("the board has five views and the health tab shows charts and the import report", async () => {
    const crm = await signIn(h, "admin");
    await AdminBoard.computeAll(h.pool, new Date());
    const home = await crm.agent.get("/app/owner/board?view=health&days=7");
    expect(home.status).toBe(200);
    for (const v of ["today", "agencies", "money", "health", "content"]) expect(home.text).toContain(`data-view="${v}"`);
    expect(home.text).toContain('data-chart="active_brokers"');
    expect(home.text).toContain("WhatsApp import");
    const content = await crm.agent.get("/app/owner/board?view=content&days=30");
    expect(content.text).toContain('data-board="content"');
  });
});
