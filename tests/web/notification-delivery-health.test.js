// tests/web/notification-delivery-health.test.js — Failed sends are retried and recorded, stuck rows are recovered,
// push failures are told apart from "nothing to send to", and the owner hears when delivery breaks.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const crypto = require("crypto");
const { resetConfig } = require("../../config");
const { createHarness, closeHarness } = require("../harness/app");
const N = require("../../lib/notifications");
const AppPush = require("../../lib/channels/apppush");
const Alerts = require("../../services/systemAlerts");

jest.setTimeout(90000);

let h;
beforeAll(() => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test";
  resetConfig();
});
afterAll(() => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  resetConfig();
  return closeHarness();
});
beforeEach(async () => {
  h = await createHarness();
  await h.query(`UPDATE brokers SET notify_prefs = '{"quiet":{"enabled":false}}' WHERE id = $1`, [h.BROKERS.broker.id]);
});

let seq = 0;
const event = (over = {}) => ({ kind: "match", dedupeKey: `ev:${++seq}`, title: "🏠 VIL-08 fits your client", url: "/app/notifications", ...over });
const brokerRow = async () => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.broker.id]))[0];
const rowOf = async () => (await h.query("SELECT status, channel, reason, attempts, last_error, deliver_after FROM notifications WHERE broker_id = $1 ORDER BY id DESC LIMIT 1", [h.BROKERS.broker.id]))[0];
const tgSent = () => h.TG.outbox.filter((e) => e.method === "sendMessage");
const minutes = (n) => new Date(Date.now() + n * 60 * 1000);

describe("Telegram failures", () => {
  test("a rate limit (429) waits and is tried again, with no push in between; it then goes out", async () => {
    await h.tgLink("broker");
    await h.Push.subscribe(h.pool, h.BROKERS.broker);
    h.TG.failSends({ code: 429, retryAfter: 1, times: 1 });
    const r = await N.notifyBroker(h.pool, await brokerRow(), event());
    expect(r).toMatchObject({ status: "queued", retry: true, attempts: 1 });
    expect(await rowOf()).toMatchObject({ status: "queued", reason: "retry", attempts: 1, last_error: "tg_429" });
    expect(h.Push.sent).toHaveLength(0);

    expect(await N.deliverDue(h.pool, { now: minutes(1) })).toEqual({ delivered: 0, groups: 0 }); // not due yet
    expect(await N.deliverDue(h.pool, { now: minutes(3) })).toMatchObject({ delivered: 1 });
    expect(await rowOf()).toMatchObject({ status: "sent", channel: "telegram", attempts: 2 });
    expect(tgSent()).toHaveLength(1);
  });

  test("after the last try it falls back to push; with no push either it is recorded as failed, not skipped", async () => {
    await h.tgLink("broker");
    h.TG.failSends({ code: 500 });
    await N.notifyBroker(h.pool, await brokerRow(), event());
    await N.deliverDue(h.pool, { now: minutes(3) });
    expect(await rowOf()).toMatchObject({ status: "queued", attempts: 2 });
    await N.deliverDue(h.pool, { now: minutes(30) });
    // Third try: nothing left to try, no push set up.
    expect(await rowOf()).toMatchObject({ status: "failed", reason: "send_failed", attempts: 3, last_error: "tg_500" });
  });

  test("after the last try a website push takes it (reason fallback, the error is kept)", async () => {
    await h.tgLink("broker");
    await h.Push.subscribe(h.pool, h.BROKERS.broker);
    h.TG.failSends({ code: 502 });
    await N.notifyBroker(h.pool, await brokerRow(), event());
    await N.deliverDue(h.pool, { now: minutes(3) });
    await N.deliverDue(h.pool, { now: minutes(30) });
    expect(await rowOf()).toMatchObject({ status: "sent", channel: "webpush", reason: "fallback", last_error: "tg_502" });
    expect(h.Push.sent).toHaveLength(1);
  });

  test("a chat that blocked the bot (403) is unreachable: skipped at once, not retried and not counted as a failure", async () => {
    await h.tgLink("broker");
    h.TG.failSends({ code: 403 });
    await N.notifyBroker(h.pool, await brokerRow(), event());
    expect(await rowOf()).toMatchObject({ status: "skipped", attempts: 1, last_error: "tg_403" });
    expect(tgSent()).toHaveLength(0);
  });
});

describe("website push failures", () => {
  const web = async () => {
    await N.savePrefs(h.pool, await brokerRow(), { channels: { match: "web" }, quiet: { enabled: false } });
    return h.Push.subscribe(h.pool, h.BROKERS.broker);
  };

  test("a push service outage (500) is retried; the subscription stays", async () => {
    const endpoint = await web();
    h.Push.statuses.set(endpoint, 500);
    await N.notifyBroker(h.pool, await brokerRow(), event());
    expect(await rowOf()).toMatchObject({ status: "queued", reason: "retry", attempts: 1, last_error: "webpush_500" });
    h.Push.statuses.clear();
    await N.deliverDue(h.pool, { now: minutes(3) });
    expect(await rowOf()).toMatchObject({ status: "sent", channel: "webpush" });
    expect((await h.query("SELECT failed_count FROM push_subscriptions"))[0].failed_count).toBe(0);
  });

  test("a gone subscription (410) is removed and nothing is retried: the inbox holds it", async () => {
    const endpoint = await web();
    h.Push.statuses.set(endpoint, 410);
    await N.notifyBroker(h.pool, await brokerRow(), event());
    expect(await rowOf()).toMatchObject({ status: "skipped", channel: "inbox", reason: "no_push", attempts: 1 });
    expect(await h.query("SELECT 1 FROM push_subscriptions")).toEqual([]);
  });
});

describe("app push", () => {
  beforeEach(() => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ project_id: "p", client_email: "x@p.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
    resetConfig();
  });
  afterEach(() => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    resetConfig();
  });
  const token = (n = "a") => `fcm-token-${n}`.padEnd(40, "x");
  const addToken = (t) => h.query("INSERT INTO device_tokens (broker_id, agency_id, token, platform) VALUES ($1, $2, $3, 'android')", [h.BROKERS.broker.id, h.BROKERS.broker.agency_id, t]);
  const fcm = (status) => Object.assign(new Error(`fcm_${status}`), { status });
  const msg = { title: "t", url: "/app/notifications" };

  test("400 is a failed send, not a dead token: the token stays until it keeps failing", async () => {
    await addToken(token());
    AppPush.setSenderForTests(async () => {
      throw fcm(400);
    });
    const r = await AppPush.send(h.BROKERS.broker, msg, { pool: h.pool });
    expect(r).toMatchObject({ ok: false, error: "apppush_400", retryable: false });
    expect(await h.query("SELECT failed_count FROM device_tokens")).toEqual([{ failed_count: 1 }]);
    for (let i = 0; i < 4; i++) await AppPush.send(h.BROKERS.broker, msg, { pool: h.pool });
    expect(await h.query("SELECT 1 FROM device_tokens")).toEqual([]);
  });

  test("404 drops the token and says there is no device; 429 and 5xx are retryable", async () => {
    await addToken(token());
    AppPush.setSenderForTests(async () => ({ gone: true }));
    expect(await AppPush.send(h.BROKERS.broker, msg, { pool: h.pool })).toMatchObject({ ok: false, error: "no_device", retryable: false });
    expect(await h.query("SELECT 1 FROM device_tokens")).toEqual([]);

    await addToken(token("b"));
    for (const status of [429, 503]) {
      AppPush.setSenderForTests(async () => {
        throw fcm(status);
      });
      expect(await AppPush.send(h.BROKERS.broker, msg, { pool: h.pool })).toMatchObject({ ok: false, error: `apppush_${status}`, retryable: true });
    }
  });

  test("the notification centre retries an app push outage and records apppush as the channel when it goes out", async () => {
    await N.savePrefs(h.pool, await brokerRow(), { channels: { match: "app" }, quiet: { enabled: false } });
    await addToken(token());
    AppPush.setSenderForTests(async () => {
      throw fcm(503);
    });
    await N.notifyBroker(h.pool, await brokerRow(), event());
    expect(await rowOf()).toMatchObject({ status: "queued", reason: "retry", last_error: "apppush_503" });
    AppPush.setSenderForTests(async () => ({ ok: true }));
    await N.deliverDue(h.pool, { now: minutes(3) });
    expect(await rowOf()).toMatchObject({ status: "sent", channel: "apppush" });
  });
});

describe("rows stuck before they went out", () => {
  test("a pending row older than 5 minutes is sent by the next run and marked recovered; a fresh one is left alone", async () => {
    await h.tgLink("broker");
    const b = h.BROKERS.broker;
    const add = (key, ago) =>
      h.query(`INSERT INTO notifications (agency_id, broker_id, kind, dedupe_key, title, created_at) VALUES ($1, $2, 'daily_brief', $3, '☀️ Your day', NOW() - $4::interval)`, [b.agency_id, b.id, key, ago]);
    await add("brief:old", "10 minutes");
    expect(await N.deliverDue(h.pool, { now: new Date() })).toMatchObject({ delivered: 1, recovered: 1 });
    expect(await rowOf()).toMatchObject({ status: "sent", channel: "telegram", reason: "recovered" });
    expect(tgSent()).toHaveLength(1);

    await add("brief:fresh", "1 minute");
    expect(await N.deliverDue(h.pool, { now: new Date() })).toEqual({ delivered: 0, groups: 0 });
    expect((await rowOf()).status).toBe("pending");
  });

  test("one broker's failure does not stop the others in the same run", async () => {
    await h.tgLink("broker", "colleague");
    for (const who of ["broker", "colleague"]) {
      const b = h.BROKERS[who];
      await h.query(`INSERT INTO notifications (agency_id, broker_id, kind, dedupe_key, title, created_at) VALUES ($1, $2, 'match', $3, 'x', NOW() - interval '10 minutes')`, [b.agency_id, b.id, `k:${who}`]);
    }
    h.TG.failSends({ code: 429, times: 1 }); // the first broker is queued for a retry, the second still goes out
    const out = await N.deliverDue(h.pool, { now: new Date() });
    expect(out.groups).toBe(2);
    expect(tgSent()).toHaveLength(1);
    expect((await h.query("SELECT status FROM notifications ORDER BY status")).map((r) => r.status)).toEqual(["queued", "sent"]);
  });
});

describe("owner alerts for delivery health", () => {
  const keys = async (now) => (await Alerts.due(h.pool, { now })).filter((a) => a.category === "delivery").map((a) => a.key);
  const failed = (n) =>
    h.query(
      `INSERT INTO notifications (agency_id, broker_id, kind, dedupe_key, title, status, last_error)
       SELECT $1, $2, 'match', 'f:' || g, 'x', 'failed', 'tg_500' FROM generate_series(1, $3) g`,
      [h.BROKERS.broker.agency_id, h.BROKERS.broker.id, n]
    );

  test("many failed sends in 3 hours raise one alert; a few do not", async () => {
    await failed(3);
    expect(await keys(new Date())).not.toContain("delivery_failures");
    await h.query(
      `INSERT INTO notifications (agency_id, broker_id, kind, dedupe_key, title, status, last_error)
       SELECT $1, $2, 'match', 'g:' || g, 'x', 'failed', 'tg_500' FROM generate_series(1, 6) g`,
      [h.BROKERS.broker.agency_id, h.BROKERS.broker.id]
    );
    const found = (await Alerts.due(h.pool, { now: new Date() })).find((a) => a.key === "delivery_failures");
    expect(found.body).toMatch(/tg_500/);
  });

  test("a row stuck pending for 15+ minutes raises a stuck alert", async () => {
    await h.query(`INSERT INTO notifications (agency_id, broker_id, kind, dedupe_key, title, created_at) VALUES ($1, $2, 'match', 'stuck', 'x', NOW() - interval '20 minutes')`, [h.BROKERS.broker.agency_id, h.BROKERS.broker.id]);
    expect(await keys(new Date())).toContain("delivery_stuck");
  });

  test("the brief not finished at 11:30 Cairo, the digest at 21:30, and a silent job each raise an alert", async () => {
    const job = (finishedAgoMin, mark, now) =>
      h.query(
        `INSERT INTO crm_jobs (name, last_started_at, last_finished_at, last_status, watermark) VALUES ('daily_digest', $1, $1, 'success', $2::jsonb)
         ON CONFLICT (name) DO UPDATE SET last_started_at = $1, last_finished_at = $1, watermark = $2::jsonb`,
        [new Date(now.getTime() - finishedAgoMin * 60000).toISOString(), JSON.stringify(mark)]
      );
    const morning = new Date("2026-01-15T09:30:00Z"); // 11:30 in Cairo
    await job(1, { brief: "2026-01-14" }, morning);
    expect(await keys(morning)).toEqual(["brief_late:2026-01-15"]);
    await job(1, { brief: "2026-01-15" }, morning);
    expect(await keys(morning)).toEqual([]);

    const evening = new Date("2026-01-15T19:30:00Z"); // 21:30 in Cairo
    await job(1, { brief: "2026-01-15", digest: "2026-01-14" }, evening);
    expect(await keys(evening)).toEqual(["digest_late:2026-01-15"]);

    await job(90, { brief: "2026-01-15", digest: "2026-01-15" }, evening);
    expect(await keys(evening)).toEqual(["daily_job_idle:2026-01-15:21"]);
  });

  test("nothing is raised when the job has never been claimed (scheduler off)", async () => {
    expect(await keys(new Date("2026-01-15T09:30:00Z"))).toEqual([]);
  });
});

describe("owner dashboard", () => {
  const { signIn } = require("../harness/web");
  const Dash = require("../../services/dashboards");
  afterEach(() => {
    delete process.env.OWNER_BROKER_IDS;
    resetConfig();
  });

  test("deliveryHealth counts the week by status, today's brief, retries and failures (codes only)", async () => {
    const b = h.BROKERS.broker;
    const add = (key, kind, status, extra = "") =>
      h.query(`INSERT INTO notifications (agency_id, broker_id, kind, dedupe_key, title, status, channel, attempts, last_error, deliver_after${extra ? ", reason" : ""}) VALUES ($1, $2, $3, $4, 'SECRET TITLE', $5, $6, $7, $8, $9${extra ? ", 'retry'" : ""})`,
        [b.agency_id, b.id, kind, key, status, status === "sent" ? "telegram" : null, status === "sent" && key === "r" ? 2 : 1, status === "failed" ? "tg_500" : null, status === "queued" ? new Date(Date.now() + 600000).toISOString() : null]);
    await add("a", "daily_brief", "sent");
    await add("r", "match", "sent");
    await add("f", "daily_brief", "failed");
    await add("q", "match", "queued", "retry");
    const d = await Dash.deliveryHealth(h.pool);
    expect(d.days[0]).toMatchObject({ sent: 2, failed: 1, retried_ok: 1 });
    expect(d.daily).toEqual([{ kind: "daily_brief", sent: 1, failed: 1, skipped: 0, waiting: 0 }]);
    expect(d).toMatchObject({ retrying: 1, stuck: 0, channels: [{ channel: "telegram", n: 2 }] });
    expect(d.failures).toEqual([expect.objectContaining({ kind: "daily_brief", error: "tg_500" })]);
    expect(JSON.stringify(d)).not.toMatch(/SECRET TITLE/);
  });

  test("the owner's dashboard shows the delivery card; a failure marks it", async () => {
    process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
    resetConfig();
    const b = h.BROKERS.broker;
    await h.query(`INSERT INTO notifications (agency_id, broker_id, kind, dedupe_key, title, status, last_error) VALUES ($1, $2, 'match', 'f', 'x', 'failed', 'tg_500')`, [b.agency_id, b.id]);
    const crm = await signIn(h, "admin");
    const page = await crm.agent.get("/app/owner");
    expect(page.status).toBe(200);
    expect(page.text).toContain('id="delivery"');
    expect(page.text).toContain("tg_500");
    expect(page.text).toContain("⚠️");
  });
});
