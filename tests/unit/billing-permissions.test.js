// tests/unit/billing-permissions.test.js — Owner switches for manager billing (renew plan, buy credits).
"use strict";

const { createTestDb } = require("../harness/db");
const Billing = require("../../services/billing");
const Credits = require("../../services/credits");

describe("agency owner delegation switches for billing", () => {
  let db;
  let pool;
  const AGENCY_ID = "a0000000-0000-0000-0000-00000000000a";
  const ownerBroker = { id: "10000000-0000-0000-0000-000000000015", agency_id: AGENCY_ID, role: "owner", name: "Agency Owner" };
  const managerBroker = { id: "10000000-0000-0000-0000-000000000014", agency_id: AGENCY_ID, role: "manager", name: "Agency Manager" };
  const normalBroker = { id: "10000000-0000-0000-0000-000000000001", agency_id: AGENCY_ID, role: "broker", name: "Broker One" };

  beforeAll(async () => {
    db = await createTestDb();
    pool = db.pool;
    await Credits.refresh(pool);
    await pool.query(
      `INSERT INTO agencies (id, name, slug, plan, approval, pilot, paid_until, manager_can_renew_plan, manager_can_buy_credits)
       VALUES ($1, 'Test Agency', 'test-ag', 'solo', 'approved', false, NOW() + INTERVAL '30 days', false, false)
       ON CONFLICT (id) DO UPDATE SET manager_can_renew_plan = false, manager_can_buy_credits = false, pilot = false, plan = 'solo'`,
      [AGENCY_ID]
    );
    await pool.query(
      `INSERT INTO brokers (id, agency_id, name, role, is_active, phone_number)
       VALUES ($1, $4, 'Owner', 'owner', true, '01000000015'),
              ($2, $4, 'Manager', 'manager', true, '01000000014'),
              ($3, $4, 'Broker', 'broker', true, '01000000001')
       ON CONFLICT (id) DO NOTHING`,
      [ownerBroker.id, managerBroker.id, normalBroker.id, AGENCY_ID]
    );
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM payments WHERE agency_id = $1", [AGENCY_ID]);
  });

  afterAll(async () => {
    if (db?.close) await db.close();
  });

  test("owner can request plan payment and credit bundles anytime", async () => {
    const p1 = await Billing.requestPayment(pool, ownerBroker, { kind: "plan", plan: "solo", months: 1 });
    expect(p1.ok).toBe(true);
    expect(p1.payment.kind).toBe("plan");

    const p2 = await Billing.requestPayment(pool, ownerBroker, { kind: "credit_bundle", bundle: "small" });
    expect(p2.ok).toBe(true);
    expect(p2.payment.kind).toBe("credit_bundle");
  });

  test("manager cannot pay when switches are off", async () => {
    const p1 = await Billing.requestPayment(pool, managerBroker, { kind: "plan", plan: "solo", months: 1 });
    expect(p1.error).toBe("owner_only");

    const p2 = await Billing.requestPayment(pool, managerBroker, { kind: "credit_bundle", bundle: "small" });
    expect(p2.error).toBe("owner_only");
  });

  test("owner toggles manager_can_renew_plan; manager can then renew plan", async () => {
    const up = await Billing.updateBillingPermissions(pool, ownerBroker, AGENCY_ID, { managerCanRenewPlan: true });
    expect(up.ok).toBe(true);
    expect(up.permissions.managerCanRenewPlan).toBe(true);

    const p1 = await Billing.requestPayment(pool, managerBroker, { kind: "plan", plan: "solo", months: 1 });
    expect(p1.ok).toBe(true);
    expect(p1.payment.kind).toBe("plan");

    // credit bundle still blocked
    const p2 = await Billing.requestPayment(pool, managerBroker, { kind: "credit_bundle", bundle: "small" });
    expect(p2.error).toBe("owner_only");
  });

  test("owner toggles manager_can_buy_credits; manager can then buy credits", async () => {
    const up = await Billing.updateBillingPermissions(pool, ownerBroker, AGENCY_ID, { managerCanBuyCredits: true });
    expect(up.ok).toBe(true);
    expect(up.permissions.managerCanBuyCredits).toBe(true);

    const p = await Billing.requestPayment(pool, managerBroker, { kind: "credit_bundle", bundle: "small" });
    expect(p.ok).toBe(true);
    expect(p.payment.kind).toBe("credit_bundle");
  });

  test("broker cannot pay even if switches are on", async () => {
    const p = await Billing.requestPayment(pool, normalBroker, { kind: "plan", plan: "solo", months: 1 });
    expect(p.error).toBe("forbidden");
  });

  test("non-owner cannot toggle billing permissions", async () => {
    const up = await Billing.updateBillingPermissions(pool, managerBroker, AGENCY_ID, { managerCanRenewPlan: false });
    expect(up.error).toBe("forbidden");
  });
});
