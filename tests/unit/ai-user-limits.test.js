// tests/unit/ai-user-limits.test.js — Per-person AI limits (spec-server.md section 4 and 6b): pool ok + allowance spent →
// blocked; pool spent + allowance left → blocked; both ok → allowed; an override beats the default; only the owner (or a
// manager the owner allowed) changes the settings, and every change is audited.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const Limits = require("../../services/aiUserLimits");
const Billing = require("../../services/billing");
const AiBlock = require("../../lib/aiBlock");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
/** n successful AI actions this month for a broker (each costs the text price). */
const use = (who, n) =>
  h.query(
    `INSERT INTO operation_logs (agency_id, broker_id, operation_type, status, model_used, metadata, created_at)
     SELECT $1, $2, 'add_unit', 'success', 'fake-model', '{}'::jsonb, NOW() FROM generate_series(1, $3::int)`,
    [h.BROKERS[who].agency_id, h.BROKERS[who].id, n]
  );
const owner = async () => {
  await h.seedBroker("owner");
  return row("owner");
};

test("a new agency is in pool mode: no personal limit, nothing blocked", async () => {
  expect(await Limits.settingsOf(h.pool, h.AGENCY_A)).toEqual({ mode: "pool", defaultCredits: null, managerCanEdit: false });
  await use("broker", 5);
  const s = await Limits.standing(h.pool, h.AGENCY_A, h.BROKERS.broker.id);
  expect(s).toMatchObject({ mode: "pool", allowance: null, remaining: null });
  expect(s.used).toBeGreaterThan(0);
  expect((await Limits.overOwnLimit(h.pool, h.AGENCY_A, h.BROKERS.broker.id)).blocked).toBe(false);
});

test("per-person mode: the default applies to everyone, an override beats it, use counts per person", async () => {
  const o = await owner();
  expect(await Limits.save(h.pool, o, { mode: "per_user", defaultCredits: 1000 })).toEqual({ ok: true });
  await use("broker", 3);
  const a = await Limits.standing(h.pool, h.AGENCY_A, h.BROKERS.broker.id);
  expect(a.allowance).toBe(1000);
  // One person's use does not touch another's.
  expect((await Limits.standing(h.pool, h.AGENCY_A, h.BROKERS.colleague.id)).used).toBe(0);
  // An override equal to what the broker used leaves them at the limit; the colleague keeps the default.
  await Limits.save(h.pool, o, { overrides: { [h.BROKERS.broker.id]: a.used } });
  expect((await Limits.overOwnLimit(h.pool, h.AGENCY_A, h.BROKERS.broker.id)).blocked).toBe(true);
  expect((await Limits.overOwnLimit(h.pool, h.AGENCY_A, h.BROKERS.colleague.id)).blocked).toBe(false);
  // A blank override goes back to the default.
  await Limits.save(h.pool, o, { overrides: { [h.BROKERS.broker.id]: "" } });
  expect((await Limits.standing(h.pool, h.AGENCY_A, h.BROKERS.broker.id)).allowance).toBe(1000);
  expect((await Limits.overOwnLimit(h.pool, h.AGENCY_A, h.BROKERS.broker.id)).blocked).toBe(a.used >= 1000);
});

test("both checks must pass: allowance spent → blocked as the person's own limit; pool spent → blocked as the pool", async () => {
  const o = await owner();
  await use("broker", 2);
  const spent = (await Limits.standing(h.pool, h.AGENCY_A, h.BROKERS.broker.id)).used;
  await Limits.save(h.pool, o, { mode: "per_user", defaultCredits: spent });
  let err;
  try {
    await Billing.checkAllowance(h.pool, h.AGENCY_A, { brokerId: h.BROKERS.broker.id });
  } catch (e) {
    err = e;
  }
  expect(err).toMatchObject({ code: "PLAN_QUOTA_EXCEEDED", kind: "user" });
  expect(AiBlock.kindOf(err)).toBe("user");
  expect(AiBlock.text("user", "en")).toMatch(/your own AI limit/i);
  // Someone with room is allowed.
  await expect(Billing.checkAllowance(h.pool, h.AGENCY_A, { brokerId: h.BROKERS.colleague.id })).resolves.toBeTruthy();
  // The pool: nobody goes on once it is spent, whatever their own allowance.
  await Limits.save(h.pool, o, { defaultCredits: 1000000 });
  await h.query("UPDATE agencies SET plan = 'free', pilot = false, paid_until = NULL, trial_ends_at = NULL WHERE id = $1", [h.AGENCY_A]);
  await use("colleague", 100000);
  let poolErr;
  try {
    await Billing.checkAllowance(h.pool, h.AGENCY_A, { brokerId: h.BROKERS.broker.id });
  } catch (e) {
    poolErr = e;
  }
  expect(poolErr).toMatchObject({ code: "PLAN_QUOTA_EXCEEDED" });
  expect(poolErr.kind).not.toBe("user");
  expect(AiBlock.kindOf(poolErr)).toBe("quota");
});

test("pool mode ignores any stored allowance", async () => {
  await h.query("UPDATE brokers SET ai_user_credits = 0 WHERE id = $1", [h.BROKERS.broker.id]);
  await use("broker", 1);
  expect((await Limits.overOwnLimit(h.pool, h.AGENCY_A, h.BROKERS.broker.id)).blocked).toBe(false);
});

test("only the owner changes the settings; a manager only after the owner allows it; nobody else ever; changes are audited", async () => {
  const o = await owner();
  const manager = await row("admin");
  const broker = await row("broker");
  expect(await Limits.save(h.pool, manager, { mode: "per_user" })).toEqual({ ok: false, error: "forbidden" });
  expect(await Limits.save(h.pool, broker, { mode: "per_user" })).toEqual({ ok: false, error: "forbidden" });
  expect(await Limits.setManagerCanEdit(h.pool, manager, true)).toEqual({ ok: false, error: "forbidden" });
  expect(await Limits.setManagerCanEdit(h.pool, o, true)).toEqual({ ok: true, allowed: true });
  expect(await Limits.save(h.pool, manager, { mode: "per_user", defaultCredits: 50 })).toEqual({ ok: true });
  expect(await Limits.save(h.pool, broker, { mode: "pool" })).toEqual({ ok: false, error: "forbidden" });
  expect(await Limits.settingsOf(h.pool, h.AGENCY_A)).toEqual({ mode: "per_user", defaultCredits: 50, managerCanEdit: true });
  await Limits.setManagerCanEdit(h.pool, o, false);
  expect(await Limits.save(h.pool, manager, { mode: "pool" })).toEqual({ ok: false, error: "forbidden" });
  const audit = await h.query("SELECT action, broker_id FROM audit_logs WHERE agency_id = $1 AND action IN ('ai_usage_settings', 'manager_can_edit_ai_settings') ORDER BY id", [h.AGENCY_A]);
  expect(audit.map((a) => a.action).sort()).toEqual(["ai_usage_settings", "manager_can_edit_ai_settings", "manager_can_edit_ai_settings"]);
  expect(audit.find((a) => a.action === "ai_usage_settings").broker_id).toBe(manager.id);
});

test("bad input is refused: unknown mode, negative, fractional or huge numbers", async () => {
  const o = await owner();
  expect(await Limits.save(h.pool, o, { mode: "everyone" })).toEqual({ ok: false, error: "mode" });
  for (const bad of [-1, 1.5, "abc", 1e9]) expect(await Limits.save(h.pool, o, { defaultCredits: bad })).toEqual({ ok: false, error: "credits" });
  expect(await Limits.save(h.pool, o, { overrides: { [h.BROKERS.broker.id]: -5 } })).toEqual({ ok: false, error: "credits" });
  expect((await Limits.settingsOf(h.pool, h.AGENCY_A)).mode).toBe("pool");
});

test("the overview: everyone gets their own standing; managers also get the people list; brokers never do", async () => {
  const o = await owner();
  await Limits.save(h.pool, o, { mode: "per_user", defaultCredits: 20 });
  const mine = await Limits.overview(h.pool, await row("broker"));
  expect(mine).toMatchObject({ mode: "per_user", canEdit: false, mine: { allowance: 20 } });
  expect(mine.people).toBeUndefined();
  const mgr = await Limits.overview(h.pool, await row("admin"));
  expect(mgr.canEdit).toBe(false);
  expect(Array.isArray(mgr.people)).toBe(true);
  expect(mgr.people.length).toBeGreaterThan(1);
});

test("a team lead is limited by the brokers-may-edit-units switch like a broker; managers and data entry never are", async () => {
  const Rights = require("../../services/unitRights");
  const o = await owner();
  await Rights.setBrokersMayWrite(h.pool, o, false);
  for (const [who, role, expected] of [["broker", "broker", false], ["colleague", "team_lead", false], ["admin", "manager", true]]) {
    await h.query("UPDATE brokers SET role = $2 WHERE id = $1", [h.BROKERS[who].id, role]);
    expect([who, await Rights.mayWrite(h.pool, await row(who))]).toEqual([who, expected]);
  }
  await h.query("UPDATE brokers SET role = 'data_entry' WHERE id = $1", [h.BROKERS.broker.id]);
  expect(await Rights.mayWrite(h.pool, await row("broker"))).toBe(true);
  await Rights.setBrokersMayWrite(h.pool, o, true);
  await h.query("UPDATE brokers SET role = 'team_lead' WHERE id = $1", [h.BROKERS.broker.id]);
  expect(await Rights.mayWrite(h.pool, await row("broker"))).toBe(true);
});
