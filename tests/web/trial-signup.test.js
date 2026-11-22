// tests/web/trial-signup.test.js — Phase 5: self-serve trial signup (no approval, no card; Telegram contact share is the OTP
// equivalent), one trial per phone and per Telegram id ever, rate limits, the demo / Contact Sales form and the owner's list
// with its alert and 14-day pilot, the Day-11 / Day-13 reminders reaching the new owner on Telegram, and the agency API whitelist.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const { resetConfig } = require("../../config");
const WebAuth = require("../../lib/webAuth");
const Credits = require("../../services/credits");
const Billing = require("../../services/billing");
const BillingNotices = require("../../services/billingNotices");
const Signup = require("../../services/signup");
const TrialSignup = require("../../services/trialSignup");
const Plans = require("../../domain/plans");

jest.setTimeout(90000);

const DAY = 86400000;
let h;
let anon;
beforeAll(() => {
  process.env.TELEGRAM_BOT_USERNAME = "Wehdat_Hub_bot";
  process.env.TELEGRAM_BOT_TOKEN = "123:test"; // Telegram on (the bot is faked)
  resetConfig();
});
beforeEach(async () => {
  h = await createHarness();
  h.TG.reset();
  await Signup.setOpen(h.pool, true);
  anon = request.agent(h.app.app);
  await anon.get("/app/signup?lang=en"); // the language cookie
});
afterAll(async () => {
  delete process.env.TELEGRAM_BOT_USERNAME;
  delete process.env.OWNER_BROKER_IDS;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.ALERT_TELEGRAM_CHAT_ID;
  resetConfig();
  await closeHarness();
});

const form = (over = {}) => ({ agency: "Delta Homes", name: "Omar", phone: "01055556666", consent: "1", ...over });
const texts = (out) => out.map((e) => e.text || "").join("\n");
const contact = (phone, userId) => ({ contact: { phone_number: phone, first_name: "Omar", user_id: userId } });

/** The website form: returns { res, token } (token is the bot's start payload from the Telegram link). */
async function submit(over = {}, agent = anon) {
  const res = await agent.post("/app/signup?lang=en").type("form").send(form(over));
  const token = (res.text.match(/start=(su_[A-Za-z0-9_-]+)/) || [])[1] || null;
  return { res, token };
}
/** Opens the bot with the start link, as Telegram user `uid`. */
const botStart = (uid, token) => h.tgText(uid, `/start ${token}`);

test("happy path: form -> Telegram link -> own contact -> approved trial agency, owner linked, sign-in link sent, owner alerted", async () => {
  expect((await anon.get("/app/signup?lang=en")).text).toMatch(/no card and no approval/i);
  const { res, token } = await submit();
  expect(res.status).toBe(200);
  expect(res.text).toContain("data-signup-telegram");
  expect(token).toBeTruthy();
  expect(await h.query("SELECT 1 FROM agencies WHERE name = 'Delta Homes'")).toEqual([]); // nothing exists before the bot step
  const stored = await h.query("SELECT token_hash FROM trial_signups");
  expect(stored[0].token_hash).not.toContain(token); // only the hash is stored

  const ask = await botStart(8801, token);
  expect(ask[0].params.reply_markup.keyboard[0][0].request_contact).toBe(true);
  expect(texts(ask)).toContain("+201055556666");

  const out = await h.tg(8801, contact("+201055556666", 8801));
  expect(texts(out)).toMatch(/\/app\/login\/confirm\?t=/);
  const [a] = await h.query("SELECT id, plan, approval, pilot, trial_ends_at, paid_until FROM agencies WHERE name = 'Delta Homes'");
  expect(a).toMatchObject({ plan: "trial", approval: "approved", pilot: false, paid_until: null });
  expect(Math.round((new Date(a.trial_ends_at) - Date.now()) / DAY)).toBe(Plans.TRIAL.days);
  const [b] = await h.query("SELECT role, is_active, phone_number, telegram_user_id, telegram_chat_id FROM brokers WHERE agency_id = $1", [a.id]);
  expect(b).toMatchObject({ role: "owner", is_active: true, phone_number: "201055556666" });
  expect(Number(b.telegram_user_id)).toBe(8801);
  expect(Number(b.telegram_chat_id)).toBe(8801);
  expect(await h.query("SELECT phone_e164, telegram_id::int AS tg FROM trial_claims")).toEqual([{ phone_e164: "+201055556666", tg: 8801 }]);
  expect(await Billing.allowance(h.pool, a.id)).toMatchObject({ source: "trial", seats: { limit: 1 }, units: { limit: 50 }, credits: { limit: 80 } });
  await TrialSignup.purge(h.pool);
  expect(await h.query("SELECT id FROM trial_signups")).toEqual([]);
  expect(await h.query("SELECT tier, offered_days, offered_credits, granted_days, granted_credits, telegram_opened_at, verified_at, agency_id FROM trial_funnel"))
    .toEqual([{ tier: "solo", offered_days: 14, offered_credits: 80, granted_days: 14, granted_credits: 80,
      telegram_opened_at: expect.any(Date), verified_at: expect.any(Date), agency_id: a.id }]);
  // the start link works once
  expect(texts(await botStart(8802, token))).toMatch(/invalid or expired/);
  // a web login link from the Telegram message signs the new owner in
  const url = texts(out).match(/\/app\/login\/confirm\?t=([A-Za-z0-9_-]+)/);
  const me = request.agent(h.app.app);
  expect((await me.get(`/app/login/confirm?t=${url[1]}`)).status).toBe(200);
});

test("Team trial keeps its plan after hydration and offers four teammate seats", async () => {
  await Credits.refresh(h.pool);
  expect(Plans.PLANS.map((plan) => plan.id)).not.toContain("trial_team");
  const invalid = await submit({ tier: "team", consent: "" });
  expect(invalid.res.text).toContain('value="team" checked');
  const { token } = await submit({ tier: "team" });
  await botStart(8812, token);
  await h.tg(8812, contact("+201055556666", 8812));
  const [agency] = await h.query("SELECT id, plan, trial_ends_at FROM agencies WHERE name = 'Delta Homes'");
  expect(agency.plan).toBe("trial_team");
  expect(await Billing.allowance(h.pool, agency.id)).toMatchObject({
    source: "trial", seats: { limit: 5 }, units: { limit: 50 }, credits: { limit: 200 }
  });
  const [owner] = await h.query("SELECT id, agency_id FROM brokers WHERE agency_id = $1", [agency.id]);
  const { agent, csrf } = await signIn(h, owner);
  const invite = (i) => agent.post("/app/team/invite").type("form").send({
    _csrf: csrf, name: 'Colleague', phone: '0109988776' + i, role: "broker"
  });
  for (let i = 0; i < 3; i++) expect((await invite(i)).status).toBe(200);
  const lastSeat = await Promise.all([invite(3), invite(4)]);
  expect(lastSeat.map((res) => res.status).sort()).toEqual([200, 402]);

  const end = new Date(agency.trial_ends_at);
  const pending = { ...agency, pending_plan_at: new Date(end.getTime() - DAY) };
  expect(Billing.effectivePlan(pending, new Date(end.getTime() + DAY))).toMatchObject({
    source: "readonly", plan: { id: "trial_team" }, paused: true
  });
  expect(Billing.effectivePlan(agency, new Date(end.getTime() + 8 * DAY))).toMatchObject({
    source: "blocked", plan: { id: "trial_team" }
  });
  expect(Billing.effectivePlan({ ...agency, plan: "team" })).toMatchObject({ source: "trial", plan: { id: "trial" } });
  expect(Billing.effectivePlan({ ...agency, plan: "team", paid_until: new Date(end.getTime() + 30 * DAY) })).toMatchObject({
    source: "paid", plan: { id: "team" }
  });
});

test("owner settings control new tier offers, verification and the granted allowance", async () => {
  const pending = await submit({ tier: "solo", phone: "01155556666" });
  await botStart(8813, pending.token);
  process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
  resetConfig();
  const admin = await signIn(h, "admin");
  try {
    const options = { _csrf: admin.csrf, trial_settings: "1", open: "1", solo_days: "14", solo_credits: "80", team_enabled: "1", team_days: "9", team_credits: "175" };
    const save = (over = {}) => admin.agent.post("/app/owner/signup").type("form").send({ ...options, ...over });
    expect((await save({ team_days: "0" })).status).toBe(422);
    expect((await save()).status).toBe(200);
    const landing = (await anon.get("/?lang=en")).text;
    expect(landing).toContain("9-day free trial · 175 AI credits");
    expect(landing).not.toContain("tier=solo");
    const page = (await anon.get("/app/signup?lang=en")).text;
    expect(page).not.toContain('name="tier" value="solo"');
    expect(page).toContain('name="tier" value="team" checked');
    expect((await submit({ tier: "solo" })).res.status).toBe(403);
    expect(texts(await h.tg(8813, contact("+201155556666", 8813)))).toMatch(/trial is closed/);
    const { token } = await submit({ tier: "team" });
    await botStart(8814, token);
    expect(texts(await h.tg(8814, contact("+201055556666", 8814)))).toMatch(/9-day free trial/);
    const [a] = await h.query("SELECT id, signed_up_at, trial_ends_at FROM agencies WHERE plan = 'trial_team'");
    expect(new Date(a.trial_ends_at) - new Date(a.signed_up_at)).toBe(9 * DAY);
    expect((await save({ team_credits: "0", team_days: "3", team_enabled: "" })).status).toBe(200);
    expect((await anon.get("/app/signup?lang=en")).text).toMatch(/closed for now/);
    expect(await Billing.allowance(h.pool, a.id)).toMatchObject({ plan: { credits: 175 }, credits: { limit: 175 } });
    expect((await save({ solo_enabled: "1", solo_days: "4", solo_credits: "0", team_enabled: "" })).status).toBe(200);
    const soloPage = (await anon.get("/app/signup?lang=en")).text;
    expect(soloPage).toContain('name="tier" value="solo" checked');
    expect(soloPage).not.toContain('name="tier" value="team"');
    const solo = await submit({ phone: "01255556666" });
    await botStart(8815, solo.token);
    expect(texts(await h.tg(8815, contact("+201255556666", 8815)))).toMatch(/4-day free trial/);
    const [soloAgency] = await h.query("SELECT id FROM agencies WHERE plan = 'trial' AND trial_ai_credits = 0");
    expect(await Billing.allowance(h.pool, soloAgency.id)).toMatchObject({ plan: { credits: 0 }, credits: { limit: 0 } });
  } finally {
    delete process.env.OWNER_BROKER_IDS;
    resetConfig();
  }
});

test("a wrong number is refused and counts an attempt; the right one still works", async () => {
  const { token } = await submit();
  await botStart(8803, token);
  const out = await h.tg(8803, contact("+201099990000", 8803));
  expect(texts(out)).toMatch(/not the one you typed/);
  expect(await h.query("SELECT 1 FROM agencies WHERE name = 'Delta Homes'")).toEqual([]);
  expect((await h.query("SELECT attempts FROM trial_signups"))[0].attempts).toBe(1);
  const ok = await h.tg(8803, contact("01055556666", 8803));
  expect(texts(ok)).toMatch(/login\/confirm/);
});

test("someone else's contact (user_id is not the sender) is refused even with the right number", async () => {
  const { token } = await submit();
  await botStart(8804, token);
  const out = await h.tg(8804, contact("+201055556666", 1234));
  expect(texts(out)).toMatch(/your own number/);
  const noId = await h.tg(8804, { contact: { phone_number: "+201055556666", first_name: "X" } });
  expect(texts(noId)).toMatch(/your own number/);
  expect(await h.query("SELECT 1 FROM agencies WHERE name = 'Delta Homes'")).toEqual([]);
  expect(await h.query("SELECT 1 FROM trial_claims")).toEqual([]);
});

test("one trial per phone ever: reuse is refused with a plans/contact message, also after the agency is gone", async () => {
  const { token } = await submit();
  await botStart(8805, token);
  await h.tg(8805, contact("+201055556666", 8805));
  const [a] = await h.query("SELECT id FROM agencies WHERE name = 'Delta Homes'");
  const again = await submit({ agency: "Second Try", name: "Omar", tier: "team" });
  expect(again.res.status).toBe(400);
  expect(again.res.text).toMatch(/already used its free trial/);
  expect(again.res.text).toContain("#plans");
  // deactivate the brokers: the claim still stands
  await h.query("UPDATE brokers SET is_active = false WHERE agency_id = $1", [a.id]);
  expect((await submit({ agency: "Third Try" })).res.status).toBe(400);
  // even if the agency row is deleted the claim survives
  await h.query("DELETE FROM brokers WHERE agency_id = $1", [a.id]);
  await h.query("DELETE FROM agencies WHERE id = $1", [a.id]);
  expect((await h.query("SELECT agency_id FROM trial_claims"))[0].agency_id).toBeNull();
  await h.query("DELETE FROM web_rate_limits"); // the per-phone limit is not what is tested here
  expect((await submit({ agency: "Fourth Try" })).res.status).toBe(400);
  // the unique index itself refuses a second claim for the same phone or the same Telegram id
  await expect(h.pool.query("INSERT INTO trial_claims (phone_e164, telegram_id) VALUES ('+201055556666', 1)")).rejects.toThrow();
  await expect(h.pool.query("INSERT INTO trial_claims (phone_e164, telegram_id) VALUES ('+201000000009', 8805)")).rejects.toThrow();
});

test("one trial per Telegram account ever: the same Telegram id with another number is refused", async () => {
  const { token } = await submit();
  await botStart(8806, token);
  await h.tg(8806, contact("+201055556666", 8806));
  const [a] = await h.query("SELECT id FROM agencies WHERE name = 'Delta Homes'");
  await h.query("UPDATE brokers SET is_active = false, telegram_user_id = NULL WHERE agency_id = $1", [a.id]); // deactivated and unlinked
  const second = await submit({ agency: "Other Co", phone: "01166667777", tier: "team" });
  expect(second.res.status).toBe(200); // the phone itself is new
  const out = await botStart(8806, second.token);
  expect(texts(out)).toMatch(/already used its free trial/);
  expect(texts(out)).toMatch(/#plans/);
  // a contact share cannot sneak it in either: no signup was tied to this Telegram account
  const share = await h.tg(8806, contact("+201166667777", 8806));
  expect(texts(share)).not.toMatch(/login\/confirm/);
  expect(await h.query("SELECT 1 FROM agencies WHERE name = 'Other Co'")).toEqual([]);
  // and the race guard: a claim for this Telegram id appearing between the bot steps is caught by the unique index
  const third = await submit({ agency: "Race Co", phone: "01255558888" });
  await botStart(8807, third.token);
  await h.query("INSERT INTO trial_claims (phone_e164, telegram_id) VALUES ('+201000000001', 8807)");
  const r = await TrialSignup.verifyContact(h.pool, { phone_number: "+201255558888", user_id: 8807 }, { userId: 8807, chatId: 8807 });
  expect(r).toEqual({ error: "trial_used" });
});

test("an expired link and too many wrong attempts are refused", async () => {
  const first = await submit();
  await h.query("UPDATE trial_signups SET expires_at = NOW() - INTERVAL '1 minute'");
  expect(texts(await botStart(8808, first.token))).toMatch(/invalid or expired/);

  const second = await submit({ phone: "01166668888" });
  await botStart(8809, second.token);
  await h.query("UPDATE trial_signups SET expires_at = NOW() - INTERVAL '1 minute' WHERE telegram_id = 8809");
  const late = await h.tg(8809, contact("+201166668888", 8809));
  expect(texts(late)).toMatch(/invalid or expired/);
  expect(await h.query("SELECT 1 FROM agencies WHERE name = 'Delta Homes'")).toEqual([]);

  const third = await submit({ phone: "01166669999" });
  await botStart(8810, third.token);
  let last;
  for (let i = 0; i < TrialSignup.MAX_ATTEMPTS; i++) last = await h.tg(8810, contact("+201000001111", 8810));
  expect(texts(last)).toMatch(/Too many wrong attempts/);
  const right = await h.tg(8810, contact("+201166669999", 8810)); // even the right number is locked out now
  expect(texts(right)).toMatch(/Too many wrong attempts/);
  expect(await h.query("SELECT 1 FROM agencies WHERE name = 'Delta Homes'")).toEqual([]);
});

test("rate limits: per IP and per phone; honeypot, consent, bad numbers and the open switch", async () => {
  expect((await submit({ consent: "" })).res.status).toBe(400);
  expect((await submit({ phone: "12345" })).res.status).toBe(400);
  expect((await submit({ website: "bot" })).res.status).toBe(303);
  expect(await h.query("SELECT 1 FROM trial_signups")).toEqual([]);
  // per phone: 3 an hour (the bad-number ones above did not count)
  for (let i = 0; i < 3; i++) expect((await submit()).res.status).toBe(200);
  const blocked = await submit();
  expect(blocked.res.status).toBe(429);
  // per IP: 5 an hour (the bad number, 3 accepted and the blocked one already used all 5), so a fresh number is refused too
  expect((await submit({ phone: "01077770002" })).res.status).toBe(429);
  await Signup.setOpen(h.pool, false);
  expect((await submit({ phone: "01077770003" })).res.status).toBe(403);
});

test("Day 11 and Day 13 reminders reach the new owner on Telegram", async () => {
  const { token } = await submit();
  await botStart(8811, token);
  await h.tg(8811, contact("+201055556666", 8811));
  const [a] = await h.query("SELECT id FROM agencies WHERE name = 'Delta Homes'");
  const [b] = await h.query("SELECT id FROM brokers WHERE agency_id = $1", [a.id]);
  // Fixed at 10:00 UTC (midday in Cairo) so the quiet-hours rule never holds the reminder back, whatever time CI runs.
  const start = new Date();
  start.setUTCHours(10, 0, 0, 0); // midday Cairo: the default quiet hours (22:00 to 08:00) would hold the message if the test ran at night
  let i = 0;
  for (const left of [3, 1]) {
    h.TG.reset();
    const now = new Date(start.getTime() + i++ * DAY); // a day apart, so the 2-minute merge window does not hold the second one
    await h.query("UPDATE agencies SET trial_ends_at = $2 WHERE id = $1", [a.id, new Date(now.getTime() + left * DAY - 3600000).toISOString()]);
    const r = await BillingNotices.remindEnding(h.pool, { now });
    expect(r.sent).toBeGreaterThan(0);
    const chat = h.TG.outbox.filter((e) => e.method === "sendMessage" && e.chatId === "8811");
    expect(chat.map((e) => e.text).join("\n")).toMatch(/free trial ends|التجربة المجانية/);
  }
  const keys = (await h.query("SELECT dedupe_key FROM notifications WHERE broker_id = $1 AND dedupe_key LIKE 'plan_end:%'", [b.id])).map((r) => r.dedupe_key.split(":").pop());
  expect(keys.sort()).toEqual(["1", "3"]);
});

describe("Track B: demo / Contact Sales", () => {
  const send = (body) => request(h.app.app).post("/try").type("form").send(body);
  const fetchSpy = () => {
    process.env.ALERT_TELEGRAM_CHAT_ID = "999";
    resetConfig();
    return jest.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true });
  };
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.ALERT_TELEGRAM_CHAT_ID;
    resetConfig();
  });

  test("the landing page routes offices to the demo form; Enterprise is Contact Sales only", async () => {
    const en = (await request(h.app.app).get("/?lang=en")).text;
    expect(en).toContain("Book a Live Demo / Contact Sales");
    expect(en).toMatch(/data-plan="office"[\s\S]*?data-plan-cta="demo"/);
    expect(en).toMatch(/data-plan="solo"[\s\S]*?data-plan-cta="trial"/);
    const ent = en.match(/data-plan="enterprise"[\s\S]*?<\/a>/)[0];
    expect(ent).toContain("Contact Sales");
    expect(ent).not.toMatch(/signup|checkout|pay/i);
    expect(en).toMatch(/Offices \(15\+ seats\) and Enterprise \(50\+\): book a live demo/);
    expect(en).not.toMatch(/\bVAT\b/i);
    expect((await request(h.app.app).get("/")).text).not.toMatch(/ضريبة/);
  });

  test("a demo request is stored as kind 'demo', alerts the owner, and shows in its own list on /app/owner", async () => {
    const spy = fetchSpy();
    expect((await send({ name: "Mona", agency: "Skyline Realty", phone: "01012345678", team: "22" })).status).toBe(303);
    expect((await send({ name: "Mona", agency: "", phone: "01012345678", team: "22" })).status).toBe(400);
    expect((await send({ name: "Mona", agency: "X", phone: "01012345678", team: "" })).status).toBe(400);
    const rows = await h.query("SELECT kind, name, agency_name, phone_e164, team_size FROM demo_requests");
    expect(rows).toEqual([{ kind: "demo", name: "Mona", agency_name: "Skyline Realty", phone_e164: "+201012345678", team_size: 22 }]);
    await new Promise((r) => setImmediate(r));
    const alert = JSON.parse(spy.mock.calls.find(([url]) => String(url).includes("/sendMessage"))[1].body);
    expect(alert.chat_id).toBe("999");
    expect(alert.text).toMatch(/Demo request #D\d+/);
    expect(alert.text).toContain("Skyline Realty");
    expect(alert.text).toContain("22 brokers");

    // a legacy 'trial' row stays in its own list
    await h.query("INSERT INTO demo_requests (name, agency_name, phone_e164, kind) VALUES ('Old', 'Legacy Co', '+201000000002', 'trial')");
    process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
    resetConfig();
    const a = await signIn(h, "admin");
    const page = (await a.agent.get("/app/owner?lang=en")).text;
    const demos = page.match(/id="demos"[\s\S]*?<\/section>/)[0];
    expect(demos).toContain("Skyline Realty");
    expect(demos).not.toContain("Legacy Co");
    expect(page.match(/id="trials"[\s\S]*?<\/section>/)[0]).toContain("Legacy Co");
  });

  test("the owner makes a guided 14-day multi-seat pilot from a demo request (once); the open-ended pilot is unchanged", async () => {
    await send({ name: "Mona", agency: "Skyline Realty", phone: "01012345678", team: "22" });
    const [d] = await h.query("SELECT id FROM demo_requests");
    process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
    resetConfig();
    const a = await signIn(h, "admin");
    const other = await signIn(h, "broker");
    expect((await other.agent.post(`/app/owner/demos/${d.id}/pilot`).type("form").send({ _csrf: other.csrf })).status).toBe(404);
    const r = await a.agent.post(`/app/owner/demos/${d.id}/pilot`).type("form").send({ _csrf: a.csrf });
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/https:\/\/t\.me\/Wehdat_Hub_bot\?start=/);
    const [ag] = await h.query("SELECT id, plan, pilot, approval, paid_until, trial_ends_at FROM agencies WHERE name = 'Skyline Realty'");
    expect(ag).toMatchObject({ plan: "office", pilot: false, approval: "approved", trial_ends_at: null });
    expect(Math.round((new Date(ag.paid_until) - Date.now()) / DAY)).toBe(14);
    const allowance = await Billing.allowance(h.pool, ag.id);
    expect(allowance).toMatchObject({ source: "paid", seats: { limit: 15 } });
    // after the 14 days it walks the normal ladder (grace) instead of staying free forever
    expect(Billing.effectivePlan({ ...ag, paid_until: new Date(Date.now() - 1000).toISOString() }).source).toBe("grace");
    expect((await h.query("SELECT pilot_agency_id FROM demo_requests"))[0].pilot_agency_id).toBe(ag.id);
    expect((await a.agent.post(`/app/owner/demos/${d.id}/pilot`).type("form").send({ _csrf: a.csrf })).status).toBe(409);
    expect(Billing.effectivePlan({ plan: "office", pilot: true, paid_until: null }).source).toBe("pilot");
  });
});

describe("agency API whitelist", () => {
  async function login(who) {
    await h.seedBroker(who);
    const b = h.BROKERS[who];
    const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
    const res = await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: b.phone, code });
    return { Authorization: `Bearer ${res.body.token}` };
  }
  const FORBIDDEN = ["founding_partner", "locked_prices", "lock_until", "extra_seats", "extraSeats", "grace_extra_until", "referral_credit_months"];
  const keysOf = (o, acc = new Set()) => {
    if (Array.isArray(o)) o.forEach((x) => keysOf(x, acc));
    else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) (acc.add(k), keysOf(v, acc));
    return acc;
  };

  test("GET /usage and GET /plan return whitelisted fields only; extra seats show only in the totals", async () => {
    await h.query(
      `UPDATE agencies SET pilot = false, plan = 'team', paid_until = NOW() + INTERVAL '20 days', founding_partner = true, extra_seats = 2,
              locked_prices = '{"team":{"1":599}}'::jsonb, lock_until = NOW() + INTERVAL '300 days', grace_extra_until = NOW() + INTERVAL '30 days' WHERE id = $1`,
      [h.AGENCY_A]
    );
    await h.query(
      "INSERT INTO payments (agency_id, kind, plan, months, amount_egp, reference, status, seats, detail) VALUES ($1, 'plan', 'team', 1, 599, 'WH-TEST-1', 'confirmed', 2, '{\"lock\":true}'::jsonb)",
      [h.AGENCY_A]
    );
    const auth = await login("owner");
    const usage = await request(h.app.app).get("/api/v1/usage").set(auth);
    expect(usage.status).toBe(200);
    const plan = await request(h.app.app).get("/api/v1/plan").set(auth);
    expect(plan.status).toBe(200);
    for (const body of [usage.body, plan.body]) {
      const keys = keysOf(body);
      for (const bad of FORBIDDEN) expect([bad, keys.has(bad)]).toEqual([bad, false]);
      expect(body.allowance).not.toHaveProperty("agency");
      expect(body.allowance.seats).toEqual({ used: expect.any(Number), limit: 7 }); // Team 5 + 2 extra
      expect(Object.keys(body.allowance).sort()).toEqual(["credits", "ladder", "plan", "seats", "source", "units", "until"]);
    }
    expect(plan.body.payments[0].reference).toBe("WH-TEST-1");
    expect(plan.body.payments[0]).not.toHaveProperty("detail");
    expect(plan.body.payments[0]).not.toHaveProperty("seats");
  });
});
