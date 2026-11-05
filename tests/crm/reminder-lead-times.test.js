// tests/crm/reminder-lead-times.test.js — Calls and viewings are reminded at the lead times each person picks (30 minutes,
// 1 hour by default, 2 hours; any combination). Each lead time is sent once per follow-up time. A follow-up booked later
// than a lead time gets its reminder at once. Moving the follow-up sends the reminders again. A time in the past is refused.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");
const Reminders = require("../../services/followUpReminders");
const Notifications = require("../../lib/notifications");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const MIN = 60 * 1000;
const reminderCount = async () => (await h.query("SELECT count(*)::int AS n FROM notifications WHERE broker_id = $1 AND dedupe_key LIKE 'fu:%'", [h.BROKERS.broker.id]))[0].n;
async function lead() {
  return (await Leads.captureLead(h.pool, await row("broker"), { phones: "01012345678", name: "Sara" })).lead;
}
async function setPrefs(minutes) {
  await Notifications.savePrefs(h.pool, await row("broker"), { reminderMinutes: minutes });
}

test("by default the reminder comes one hour before, once", async () => {
  const l = await lead();
  const at = new Date(Date.now() + 3 * 60 * MIN);
  await Leads.setFollowUp(h.pool, await row("broker"), l.id, { at });
  expect((await Reminders.remindDue(h.pool, { now: new Date(at.getTime() - 3 * 60 * MIN) })).reminded).toBe(0);
  expect((await Reminders.remindDue(h.pool, { now: new Date(at.getTime() - 60 * MIN) })).reminded).toBe(1);
  expect((await Reminders.remindDue(h.pool, { now: new Date(at.getTime() - 50 * MIN) })).reminded).toBe(0);
  expect(await reminderCount()).toBe(1);
});

test("a person who picks 30 minutes and 2 hours gets both, one at a time, and not the hour", async () => {
  await setPrefs([30, 120]);
  const l = await lead();
  const at = new Date(Date.now() + 3 * 60 * MIN);
  await Leads.setFollowUp(h.pool, await row("broker"), l.id, { at });
  expect((await Reminders.remindDue(h.pool, { now: new Date(at.getTime() - 120 * MIN) })).reminded).toBe(1);
  expect((await Reminders.remindDue(h.pool, { now: new Date(at.getTime() - 60 * MIN) })).reminded).toBe(0);
  expect((await Reminders.remindDue(h.pool, { now: new Date(at.getTime() - 30 * MIN) })).reminded).toBe(1);
  expect(await reminderCount()).toBe(2);
});

test("a follow-up booked later than the lead time is reminded at once, in one message", async () => {
  const l = await lead();
  const at = new Date(Date.now() + 10 * MIN);
  await Leads.setFollowUp(h.pool, await row("broker"), l.id, { at });
  expect((await Reminders.remindDue(h.pool, { now: new Date() })).reminded).toBe(1);
  expect((await Reminders.remindDue(h.pool, { now: new Date(at.getTime() - 5 * MIN) })).reminded).toBe(0);
  expect(await reminderCount()).toBe(1);
});

test("moving the follow-up sends its reminders again", async () => {
  const l = await lead();
  const at = new Date(Date.now() + 90 * MIN);
  await Leads.setFollowUp(h.pool, await row("broker"), l.id, { at });
  expect((await Reminders.remindDue(h.pool, { now: new Date(at.getTime() - 60 * MIN) })).reminded).toBe(1);
  const later = new Date(Date.now() + 5 * 60 * MIN);
  await Leads.setFollowUp(h.pool, await row("broker"), l.id, { at: later });
  expect((await Reminders.remindDue(h.pool, { now: new Date(later.getTime() - 30 * MIN) })).reminded).toBe(1);
});

test("a time in the past is refused for a call or viewing", async () => {
  const l = await lead();
  const res = await Leads.setFollowUp(h.pool, await row("broker"), l.id, { at: new Date(Date.now() - 60 * MIN) });
  expect(res.error).toBe("follow_up_past");
});

test("saving the reminder choice: none picked means one hour; a mix is kept", async () => {
  expect(Notifications.prefsOf(await row("broker")).reminderMinutes).toEqual([60]);
  await setPrefs([120, 30, 30]);
  expect(Notifications.prefsOf(await row("broker")).reminderMinutes).toEqual([30, 120]);
  await setPrefs([]);
  expect(Notifications.prefsOf(await row("broker")).reminderMinutes).toEqual([60]);
});

test("the settings page offers the three lead times", async () => {
  const b = await signIn(h, "broker");
  const page = (await b.agent.get("/app/settings?lang=en")).text;
  expect(page).toMatch(/name="rm_30"/);
  expect(page).toMatch(/name="rm_60"[^>]*checked/);
  expect(page).toMatch(/name="rm_120"/);
});
