// tests/web/notify-policy.test.js — The agency's notification policy in use: the owner locks a channel and a manager cannot
// change it; a batched kind waits for its slot and goes out then; a switched-off kind is not sent; a person sees a locked
// setting as locked on their Settings page; and the old per-person panel is gone.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const N = require("../../lib/notifications");
const P = require("../../lib/notificationPolicy");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const brokerRow = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const setPolicy = (policy) => h.query("UPDATE agencies SET notify_policy = $2::jsonb WHERE id = $1", [h.AGENCY_A, JSON.stringify(policy)]);

test("the owner's lock on a channel holds for everyone; a manager cannot change it", async () => {
  await h.seedBroker("owner");
  await setPolicy({ match: { channel: "web", lock: "owner" } });
  const b = await brokerRow("broker");
  await N.savePrefs(h.pool, b, { channels: { match: "whatsapp" } });
  expect((await N.effectiveFor(h.pool, await brokerRow("broker"), "match")).channel).toBe("web");

  await h.seedBroker("manager");
  const m = await signIn(h, "manager");
  const r = await m.agent.post("/app/team/policy").type("form").send({ _csrf: m.csrf, ch_match: "telegram" });
  expect(r.status).toBe(200);
  expect(r.text).toMatch(/owner has locked|المالك قفل/);
  expect((await h.query("SELECT notify_policy FROM agencies WHERE id = $1", [h.AGENCY_A]))[0].notify_policy.match).toEqual({ channel: "web", lock: "owner" });
});

test("a batched kind waits for its slot and goes out then; a switched-off kind is not sent", async () => {
  await setPolicy({ match: { frequency: "hourly" }, share_opened: { on: false } });
  const b = await brokerRow("broker");
  const batched = await N.notifyBroker(h.pool, b, { kind: "match", dedupeKey: "m1", title: "Match one", now: new Date("2026-11-05T10:20:00Z") });
  expect(batched).toMatchObject({ held: true, batched: true });
  expect((await h.query("SELECT status, reason, deliver_after FROM notifications WHERE dedupe_key = 'm1'"))[0]).toMatchObject({ status: "held", reason: "batched" });
  await N.deliverDue(h.pool, { now: new Date("2026-11-05T11:00:01Z") });
  // Its slot came: the batch was processed (in this test there is no WhatsApp window or push, so it is not "held" any more).
  expect((await h.query("SELECT status FROM notifications WHERE dedupe_key = 'm1'"))[0].status).not.toBe("held");

  const off = await N.notifyBroker(h.pool, b, { kind: "share_opened", dedupeKey: "s1", title: "Opened" });
  expect(off).toMatchObject({ status: "skipped", reason: "policy_off" });
});

test("an urgent kind is not batched even if the policy batches it", async () => {
  await setPolicy({ assignment: { frequency: "daily" } });
  const out = await N.notifyBroker(h.pool, await brokerRow("broker"), { kind: "assignment", dedupeKey: "a1", title: "Lead" });
  expect(out.held).toBeUndefined();
  expect((await h.query("SELECT status FROM notifications WHERE dedupe_key = 'a1'"))[0].status).not.toBe("held");
});

test("a person sees a setting the owner locked as locked, and cannot change it", async () => {
  await h.seedBroker("owner");
  await setPolicy({ match: { channel: "web", lock: "owner" } });
  const b = await signIn(h, "broker");
  const page = (await b.agent.get("/app/settings?lang=en")).text;
  expect(page).toMatch(/data-locked-by="owner"/);
  expect(page).toMatch(/<select name="ch_match" data-kind="match" disabled>/);
});

test("the per-person notification panel is gone from the team card", async () => {
  await h.seedBroker("manager");
  const m = await signIn(h, "manager");
  const page = (await m.agent.get("/app/team?lang=en")).text;
  expect(page).not.toMatch(/data-notify-row/);

  expect(page).toMatch(/data-policy-row="match"/);
});

test("an owner's save sets a kind for everyone and a lock", async () => {
  await h.seedBroker("owner");
  const o = await signIn(h, "owner");
  const r = await o.agent.post("/app/team/policy").type("form").send({ _csrf: o.csrf, ch_match: "web", fq_match: "hourly", lock_match: "1" });
  expect(r.status).toBe(200);
  expect((await h.query("SELECT notify_policy FROM agencies WHERE id = $1", [h.AGENCY_A]))[0].notify_policy.match).toEqual({ channel: "web", frequency: "hourly", lock: "owner" });
  expect(P.policyOf({ notify_policy: { match: { channel: "web" } } }).match).toEqual({ channel: "web" });
});
