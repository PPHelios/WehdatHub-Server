// tests/web/notify-options.test.js — Per person: a manager switches each notification on or off and may fix its channel for
// that person. A fixed channel wins over the person's own choice, is shown to the person as set by the manager, and the
// person's own saves do not change it. "They choose" leaves the person's own setting in charge.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const N = require("../../lib/notifications");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const brokerRow = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];

test("a manager fixes the channel for one person's notification; the person's own choice does not override it", async () => {
  await N.savePrefs(h.pool, await brokerRow("broker"), { channels: { match: "both" }, quiet: { enabled: false } });
  const a = await signIn(h, "admin");
  const r = await a.agent.post(`/app/team/${h.BROKERS.broker.id}/notify`).type("form").send({
    _csrf: a.csrf,
    sent: "1",
    on: ["assignment", "follow_up", "match", "share_opened", "hot_client"],
    ch_match: "web"
  });
  expect(r.status).toBe(200);
  const prefs = N.prefsOf(await brokerRow("broker"), { telegramLinked: true });
  expect(prefs.channels.match).toBe("web");
  expect(prefs.managed).toEqual({ match: "web" });

  // The person's own Settings: the fixed kind is shown as set by the manager, and their save keeps it.
  const b = await signIn(h, "broker");
  const page = (await b.agent.get("/app/settings?lang=en")).text;
  expect(page).toMatch(/data-managed-by-owner/);
  expect(page).toMatch(/<select name="ch_match" data-kind="match" disabled>/);
  const save = await b.agent.post("/app/settings").type("form").send({ _csrf: b.csrf, lang: "en", ch_assignment: "web", ch_follow_up: "web", ch_share_opened: "web", ch_hot_client: "web", quiet_start: "22", quiet_end: "8" });
  expect(save.status).toBe(303);
  expect(N.prefsOf(await brokerRow("broker"), { telegramLinked: true }).channels.match).toBe("web");
  expect(N.prefsOf(await brokerRow("broker"), { telegramLinked: true }).channels.assignment).toBe("web");
});

test("a kind switched off goes to the inbox only; switching it back on removes the switch; \"they choose\" clears the fixed channel", async () => {
  const a = await signIn(h, "admin");
  await a.agent.post(`/app/team/${h.BROKERS.broker.id}/notify`).type("form").send({ _csrf: a.csrf, sent: "1", on: ["assignment"], ch_match: "telegram" });
  let p = N.prefsOf(await brokerRow("broker"), { telegramLinked: true });
  expect(p.off).toEqual(expect.arrayContaining(["match", "follow_up", "share_opened", "hot_client"]));
  expect(p.managed).toEqual({ match: "telegram" });
  await a.agent.post(`/app/team/${h.BROKERS.broker.id}/notify`).type("form").send({ _csrf: a.csrf, sent: "1", on: ["assignment", "match", "follow_up", "share_opened", "hot_client", "daily_brief", "daily_digest", "unit_check", "onboarding"], ch_match: "" });
  p = N.prefsOf(await brokerRow("broker"), { telegramLinked: true });
  expect(p.off).toEqual([]);
  expect(p.managed).toEqual({});
});

test("the options cover every kind the person receives, and only those", async () => {
  const a = await signIn(h, "admin");
  const broker = await signIn(h, "broker");
  const page = (await a.agent.get("/app/team?lang=en")).text;
  expect(page).toMatch(new RegExp(`data-notify-row="assignment"`));
  expect(page).toMatch(new RegExp(`name="ch_assignment"`));
  expect(page).not.toMatch(/name="ch_team_activity"/); // a broker does not get team activity
  expect(N.kindsFor(await brokerRow("broker"))).not.toContain("manager_alert");
  expect(broker.agent).toBeDefined();
});
