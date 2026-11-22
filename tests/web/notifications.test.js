// tests/web/notifications.test.js — The notification centre (one channel per alert), message credits,
// the inbox, settings, usage and web push (Release 3 step 2, Q15)
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { resetConfig } = require("../../config");
const { createHarness, closeHarness, textOf } = require("../harness/app");
const { signIn } = require("../harness/web");
const N = require("../../lib/notifications");
const Credits = require("../../lib/credits");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const brokerRow = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
let seq = 0;
/** The broker messaged the bot recently: their 24-hour window is open. */
const openWindow = (who, ago = "1 hour") =>
  h.query(`INSERT INTO inbound_messages (msg_id, phone_key, payload, status, received_at) VALUES ($1, $2, '{}', 'completed', NOW() - $3::interval)`, [
    `wamid.win.${++seq}`,
    h.BROKERS[who].phone,
    ago
  ]);
/** n accepted WhatsApp sends this month for a broker (credits used). */
const used = (who, n, kind = "reply") =>
  h.query(
    `INSERT INTO operation_logs (agency_id, broker_id, operation_type, status, metadata, created_at)
     SELECT $1, $2, 'wa_outbound', 'success', jsonb_build_object('kind', $4::text, 'action', 'search'), NOW() FROM generate_series(1, $3)`,
    [h.BROKERS[who].agency_id, h.BROKERS[who].id, n, kind]
  );
const event = (over = {}) => ({ kind: "match", dedupeKey: `ev:${++seq}`, title: "🏠 VIL-08 fits your client", url: "/app/notifications", ...over });
const rowsOf = (who) => h.query("SELECT kind, channel, reason, status FROM notifications WHERE broker_id = $1 ORDER BY id", [h.BROKERS[who].id]);

describe("one notification, one channel (Q15): Telegram, website, app; WhatsApp is no channel", () => {
  beforeAll(() => {
    process.env.TELEGRAM_BOT_TOKEN = "123:test";
    resetConfig();
  });
  afterAll(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    resetConfig();
  });
  const tgTo = (who) => h.TG.outbox.filter((e) => e.method === "sendMessage" && e.chatId === String(h.TG_IDS[who]));

  test("a linked broker with no choice gets Telegram and the website push together; nothing on WhatsApp", async () => {
    await h.tgLink("broker");
    await h.Push.subscribe(h.pool, h.BROKERS.broker);
    const r = await N.notifyBroker(h.pool, await brokerRow("broker"), event());
    expect(r).toMatchObject({ channel: "telegram", reason: "chosen", status: "sent" });
    expect(tgTo("broker")).toHaveLength(1);
    expect(tgTo("broker")[0].text).toMatch(/VIL-08 fits your client/);
    expect(h.Push.sent).toHaveLength(1);
    expect(h.WA.outbox).toHaveLength(0);
    expect(await h.query("SELECT 1 FROM operation_logs WHERE operation_type = 'wa_outbound'")).toEqual([]);
  });

  test("an old saved WhatsApp choice reads as no choice: Telegram and website when linked, else the website", async () => {
    await h.query(`UPDATE brokers SET notify_prefs = '{"channels":{"match":"whatsapp"},"quiet":{"enabled":false}}' WHERE id = $1`, [h.BROKERS.broker.id]);
    const b = await brokerRow("broker");
    expect(N.CHANNELS).not.toContain("whatsapp");
    expect(N.prefsOf(b, { telegramLinked: false }).channels.match).toBe("web");
    expect(N.prefsOf(b, { telegramLinked: true }).channels.match).toBe("both");
    await h.Push.subscribe(h.pool, h.BROKERS.broker);
    const r = await N.notifyBroker(h.pool, b, event());
    expect(r).toMatchObject({ channel: "webpush", status: "sent" });
    expect(h.WA.outbox).toHaveLength(0);
  });

  test("Telegram chosen but not linked: web push takes it once, reason not_linked", async () => {
    await h.Push.subscribe(h.pool, h.BROKERS.broker);
    const b = await brokerRow("broker");
    await N.savePrefs(h.pool, b, { channels: { match: "telegram" }, quiet: { enabled: false } });
    const r = await N.notifyBroker(h.pool, await brokerRow("broker"), event());
    expect(r).toMatchObject({ channel: "webpush", reason: "not_linked", status: "sent" });
    expect(h.TG.outbox).toHaveLength(0);
    expect(h.Push.sent).toHaveLength(1);
    expect(h.WA.outbox).toHaveLength(0);
  });

  test("saving the old value 'whatsapp' from a form is refused: it is stored as the website", async () => {
    const b = await brokerRow("broker");
    await N.savePrefs(h.pool, b, { channels: { match: "whatsapp" }, quiet: { enabled: false } });
    expect((await brokerRow("broker")).notify_prefs.channels.match).toBe("web");
  });

  test("website chosen and no push enabled: the inbox alone (status skipped, reason no_push)", async () => {
    const b = await brokerRow("broker");
    await N.savePrefs(h.pool, b, { channels: { match: "web" }, quiet: { enabled: false } });
    const r = await N.notifyBroker(h.pool, await brokerRow("broker"), event());
    expect(r).toMatchObject({ channel: "inbox", reason: "no_push", status: "skipped" });
    expect(h.WA.outbox).toHaveLength(0);
    expect(await N.unreadCount(h.pool, b)).toBe(1);
  });

  test("the same event twice notifies once", async () => {
    await h.tgLink("broker");
    const b = await brokerRow("broker");
    const ev = event({ dedupeKey: "same" });
    await N.notifyBroker(h.pool, b, ev);
    expect(await N.notifyBroker(h.pool, b, ev)).toEqual({ duplicate: true });
    await Promise.all([N.notifyBroker(h.pool, b, ev), N.notifyBroker(h.pool, b, ev)]);
    expect(await rowsOf("broker")).toHaveLength(1);
    expect(tgTo("broker")).toHaveLength(1);
  });

  test("alerts of one kind within 2 minutes go out as one grouped message", async () => {
    await h.tgLink("broker");
    const b = await brokerRow("broker");
    await N.notifyBroker(h.pool, b, event({ title: "first" }));
    const q1 = await N.notifyBroker(h.pool, b, event({ title: "second" }));
    const q2 = await N.notifyBroker(h.pool, b, event({ title: "third" }));
    expect(q1).toMatchObject({ queued: true });
    expect(q2).toMatchObject({ queued: true });
    expect(tgTo("broker")).toHaveLength(1);
    // Another kind is not merged.
    await N.notifyBroker(h.pool, b, event({ kind: "share_opened", title: "opened" }));
    expect(tgTo("broker")).toHaveLength(2);

    expect(await N.deliverDue(h.pool, { now: new Date(Date.now() + 60 * 1000) })).toEqual({ delivered: 0, groups: 0 });
    expect(await N.deliverDue(h.pool, { now: new Date(Date.now() + 3 * 60 * 1000) })).toEqual({ delivered: 2, groups: 1 });
    const grouped = tgTo("broker")[2].text;
    expect(grouped).toMatch(/🔔 2 تنبيهات\n• second\n• third/);
    const rows = await h.query("SELECT title, reason, status, merged_into IS NOT NULL AS merged FROM notifications WHERE broker_id = $1 ORDER BY id", [h.BROKERS.broker.id]);
    expect(rows.map((r) => [r.title, r.status])).toEqual([
      ["first", "sent"],
      ["second", "sent"],
      ["third", "sent"],
      ["opened", "sent"]
    ]);
    expect(rows[2]).toMatchObject({ reason: "merged", merged: true });
  });

  test("quiet hours hold alerts until they end, then one message", async () => {
    await h.query(`UPDATE brokers SET notify_prefs = '{"quiet":{"enabled":true,"start":22,"end":8}}' WHERE id = $1`, [h.BROKERS.broker.id]);
    const b = await brokerRow("broker");
    const night = new Date("2026-11-03T21:30:00Z"); // 23:30 Cairo
    expect(N.inQuietHours(N.prefsOf(b), night)).toBe(true);
    const r = await N.notifyBroker(h.pool, b, event({ now: night }));
    expect(r).toMatchObject({ held: true });
    const [{ deliver_after }] = await h.query("SELECT deliver_after FROM notifications");
    expect(new Date(deliver_after).toISOString()).toBe("2026-11-04T06:00:00.000Z"); // 08:00 Cairo
    expect(await N.deliverDue(h.pool, { now: new Date("2026-11-04T05:00:00Z") })).toEqual({ delivered: 0, groups: 0 });
    await h.Push.subscribe(h.pool, h.BROKERS.broker);
    const out = await N.deliverDue(h.pool, { now: new Date("2026-11-04T06:01:00Z") });
    expect(out).toEqual({ delivered: 1, groups: 1 });
    // Not linked to Telegram: the default is the website push.
    expect(await rowsOf("broker")).toEqual([{ kind: "match", channel: "webpush", reason: "chosen", status: "sent" }]);
  });

  test("an inactive broker is never messaged; the url must be an /app/ path", async () => {
    await h.tgLink("broker");
    const b = { ...(await brokerRow("broker")), is_active: false };
    expect(await N.notifyBroker(h.pool, b, event())).toMatchObject({ status: "skipped" });
    expect(h.WA.outbox).toHaveLength(0);
    expect(h.TG.outbox).toHaveLength(0);
    await expect(N.notifyBroker(h.pool, await brokerRow("broker"), event({ url: "https://evil.example" }))).rejects.toThrow(/\/app\//);
  });
});

describe("message credits", () => {
  test("there is no message limit: the state is always ok, with no caps and no sign-in ceiling", async () => {
    const Credits = require("../../lib/credits");
    const state = await Credits.check(h.pool, await brokerRow("broker"));
    expect(state).toMatchObject({ level: "ok", pct: 0, broker: { capped: false }, login: { reached: false } });
    expect(Credits.allowsSend(state, "reply")).toBe(true);
    expect(Credits.allowsSend(state, "web_login_link")).toBe(true);
  });

  test("every paid send counts with its action; the usage page shows the same numbers", async () => {
    await h.text("broker", "مساعدة");
    await h.text("broker", "شقة في التجمع");
    const logs = await h.query("SELECT metadata->>'action' AS action, count(*)::int AS n FROM operation_logs WHERE operation_type = 'wa_outbound' AND status = 'success' AND broker_id = $1 GROUP BY 1 ORDER BY 1", [h.BROKERS.broker.id]);
    expect(logs.find((l) => l.action === "search")).toBeTruthy();
    const total = logs.reduce((s, l) => s + l.n, 0);
    const { agent } = await signIn(h, "broker");
    const page = await agent.get("/app/usage");
    expect(page.status).toBe(200);
    expect(page.text).not.toContain("data-credits-used"); // the WhatsApp credits card is gone (Telegram is free)
    expect(total).toBeGreaterThan(0);
    expect(page.text).not.toContain("data-broker="); // no per-broker message table any more
  });
});

describe("website: inbox, log, settings, usage, push", () => {
  test("🔔 count, inbox, open marks read and redirects; another broker can't touch it", async () => {
    const b = await brokerRow("broker");
    await N.savePrefs(h.pool, b, { channels: { match: "web" }, quiet: { enabled: false } });
    const { id } = await N.notifyBroker(h.pool, await brokerRow("broker"), event({ title: "🏠 match one", url: "/app/units" }));
    const me = await signIn(h, "broker");
    const home = await me.agent.get("/app/");
    expect(home.text).toContain('data-unread="1"');
    const inbox = await me.agent.get("/app/notifications");
    expect(inbox.text).toContain("🏠 match one");

    const other = await signIn(h, "colleague");
    const sneak = await other.agent.post(`/app/notifications/${id}/open`).set("X-CSRF-Token", other.csrf);
    expect(sneak.headers.location).toBe("/app/notifications");
    expect((await other.agent.get("/app/notifications")).text).not.toContain("match one");
    expect(await N.unreadCount(h.pool, b)).toBe(1);

    const open = await me.agent.post(`/app/notifications/${id}/open`).set("X-CSRF-Token", me.csrf);
    expect(open.status).toBe(303);
    expect(open.headers.location).toBe("/app/units");
    expect(await N.unreadCount(h.pool, b)).toBe(0);
    expect((await me.agent.get("/app/")).text).not.toContain("data-unread");
    // No CSRF token → refused.
    expect((await me.agent.post("/app/notifications/read-all")).status).toBe(403);
  });

  test("the notification log is for managers, and only their agency", async () => {
    await N.notifyBroker(h.pool, await brokerRow("broker"), event({ title: "alpha alert" }));
    await N.notifyBroker(h.pool, await brokerRow("rival"), event({ title: "beta alert" }));
    const broker = await signIn(h, "broker");
    expect((await broker.agent.get("/app/notifications/log")).status).toBe(403);
    const admin = await signIn(h, "admin");
    const log = await admin.agent.get("/app/notifications/log");
    expect(log.status).toBe(200);
    expect(log.text).toContain("alpha alert");
    expect(log.text).not.toContain("beta alert");
    expect(log.text).toMatch(/Broker One/);
  });

  test("settings round trip (CSRF): channel per kind, quiet hours, language", async () => {
    const me = await signIn(h, "broker");
    const page = await me.agent.get("/app/settings");
    expect(page.status).toBe(200);
    expect(page.text).toContain('data-vapid="BTestPublicKey"');
    expect((await me.agent.post("/app/settings").type("form").send({ ch_match: "web" })).status).toBe(403);
    const save = await me.agent
      .post("/app/settings")
      .type("form")
      .send({ _csrf: me.csrf, ch_match: "web", ch_assignment: "whatsapp", ch_follow_up: "bogus", quiet_on: "1", quiet_start: "23", quiet_end: "7", lang: "en" });
    expect(save.status).toBe(303);
    const [b] = await h.query("SELECT notify_prefs, preferred_lang FROM brokers WHERE id = $1", [h.BROKERS.broker.id]);
    expect(b.preferred_lang).toBe("en");
    expect(b.notify_prefs.channels).toMatchObject({ match: "web", assignment: "web", follow_up: "web" });
    expect(b.notify_prefs.quiet).toEqual({ enabled: true, start: 23, end: 7 });
    const again = await me.agent.get("/app/settings");
    expect(again.text).toContain('<select name="ch_match" data-kind="match"><option value="web" selected>Website and app push</option></select>');
    expect(again.text).not.toMatch(/\(free\)/);
    expect(again.text).not.toMatch(/WhatsApp \(uses credits\)|value="whatsapp"/);
  });

  test("push: subscribe from the browser, test push, 410 removes the subscription, payload has no phone", async () => {
    const me = await signIn(h, "broker");
    const bad = await me.agent.post("/app/push/subscribe").set("X-CSRF-Token", me.csrf).type("form").send({ endpoint: "http://insecure", p256dh: "x", auth: "y" });
    expect(bad.status).toBe(400);
    const endpoint = "https://fcm.googleapis.com/fcm/send/abc123def456";
    const ok = await me.agent
      .post("/app/push/subscribe")
      .set("X-CSRF-Token", me.csrf)
      .type("form")
      .send({ endpoint, p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u", auth: "tBHItJI5svbpez7KI4CCXg" });
    expect(ok.status).toBe(204);
    const test = await me.agent.post("/app/push/test").set("X-CSRF-Token", me.csrf);
    expect(test.headers.location).toBe("/app/settings?test=ok");
    expect(h.Push.sent).toHaveLength(1);
    expect(Object.keys(h.Push.sent[0].payload).sort()).toEqual(["body", "title", "url"]);

    await N.notifyBroker(h.pool, await brokerRow("broker"), event({ title: "Client 01012345678 opened VIL-08", push: { title: "عميل 01012345678", body: "+201012345678" } }));
    const last = h.Push.sent[h.Push.sent.length - 1].raw;
    expect(last).not.toMatch(/01012345678|201012345678/);

    h.Push.statuses.set(endpoint, 410);
    await N.notifyBroker(h.pool, await brokerRow("broker"), event({ kind: "hot_client" }));
    expect(await h.query("SELECT * FROM push_subscriptions")).toEqual([]);
  });

  test("usage: only managers may post the agency form; it changes the code letters", async () => {
    const broker = await signIn(h, "broker");
    expect((await broker.agent.post("/app/usage/agency").set("X-CSRF-Token", broker.csrf).type("form").send({ code_prefix: "ZZ" })).status).toBe(403);
    await h.seedBroker("owner");
    const admin = await signIn(h, "owner");
    const save = await admin.agent.post("/app/usage/agency").set("X-CSRF-Token", admin.csrf).type("form").send({ code_prefix: "ZZ" });
    expect(save.status).toBe(303);
    expect(await h.query("SELECT code_prefix FROM agencies WHERE id = $1", [h.AGENCY_A])).toEqual([{ code_prefix: "ZZ" }]);
  });

});

describe("settings list only the kinds a role receives", () => {
  const { signIn } = require("../harness/web");
  const kindsOnPage = (text) => [...text.matchAll(/data-kind="([a-z_]+)"/g)].map((m) => m[1]);

  test("kindsFor: brokers, team leads, managers and data entry", () => {
    const N = require("../../lib/notifications");
    expect(N.kindsFor({ role: "broker" })).toEqual(["assignment", "follow_up", "match", "share_opened", "hot_client"]);
    expect(N.kindsFor({ role: "team_lead" })).toContain("team_activity");
    expect(N.kindsFor({ role: "team_lead" })).not.toContain("manager_alert");
    expect(N.kindsFor({ role: "manager" })).toContain("manager_alert");
    expect(N.kindsFor({ role: "manager" })).not.toContain("team_activity");
    expect(N.kindsFor({ role: "data_entry" })).toEqual([]);
    expect(N.dailyKindsFor({ role: "data_entry" })).toEqual(["onboarding"]);
  });

  test("the settings page matches the role", async () => {
    const broker = await signIn(h, "broker");
    const bk = kindsOnPage((await broker.agent.get("/app/settings?lang=en")).text);
    expect(bk).toContain("match");
    expect(bk).not.toContain("manager_alert");
    expect(bk).not.toContain("team_activity");
    const admin = await signIn(h, "admin");
    expect(kindsOnPage((await admin.agent.get("/app/settings?lang=en")).text)).toContain("manager_alert");
  });
});

describe("migration 122: WhatsApp is no notification channel", () => {
  test("a saved 'whatsapp' choice and a forced 'whatsapp' policy channel are dropped; the rest stays", async () => {
    const sql = require("fs").readFileSync(require("path").join(__dirname, "../../db/migrations/122_notify_telegram_only.sql"), "utf8");
    await h.query(`UPDATE brokers SET notify_prefs = '{"channels":{"match":"whatsapp","assignment":"both"},"quiet":{"enabled":false}}' WHERE id = $1`, [h.BROKERS.broker.id]);
    await h.query(`UPDATE agencies SET notify_policy = '{"match":{"channel":"whatsapp","lock":"owner","on":true},"assignment":{"channel":"telegram"}}' WHERE id = $1`, [h.AGENCY_A]);
    await h.pool.query(sql);
    await h.pool.query(sql); // twice is safe
    const [b] = await h.query("SELECT notify_prefs FROM brokers WHERE id = $1", [h.BROKERS.broker.id]);
    expect(b.notify_prefs).toEqual({ channels: { assignment: "both" }, quiet: { enabled: false } });
    const [a] = await h.query("SELECT notify_policy FROM agencies WHERE id = $1", [h.AGENCY_A]);
    expect(a.notify_policy).toEqual({ match: { lock: "owner", on: true }, assignment: { channel: "telegram" } });
  });
});

test("credit warnings (80% / 100%) reach the agency owner and the managers, each once", async () => {
  await h.seedBroker("owner");
  const who = ["admin", "owner"];
  for (const w of who) expect((await brokerRow(w)).role).toMatch(/admin|owner/);
  const ids = (await N.managersOf(h.pool, h.AGENCY_A)).map((m) => m.id);
  expect(ids).toContain(h.BROKERS.owner.id);
  expect(new Set(ids).size).toBe(ids.length);
  await N.creditWarning(h.pool, h.AGENCY_A, { level: 80, state: { used: 80, limit: 100 } });
  await N.creditWarning(h.pool, h.AGENCY_A, { level: 80, state: { used: 81, limit: 100 } });
  await N.creditWarning(h.pool, h.AGENCY_A, { level: 100, state: { used: 100, limit: 100 } });
  const rows = await h.query("SELECT broker_id, dedupe_key FROM notifications WHERE dedupe_key LIKE 'credits_warn:%'");
  const owner = rows.filter((r) => r.broker_id === h.BROKERS.owner.id).map((r) => r.dedupe_key.split(":")[2]).sort();
  expect(owner).toEqual(["100", "80"]);
  expect(rows.length).toBe(ids.length * 2);
});
