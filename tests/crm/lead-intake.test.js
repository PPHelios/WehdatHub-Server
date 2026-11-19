// tests/crm/lead-intake.test.js — L1/L7/L8: direct Facebook Lead Ads intake: Page token validated and subscribed via Graph,
// /webhook/leadgen (verify handshake, signature), source, round robin, dedupe by phone and by leadgen id, Graph failure
// logged, test button, log without phones, quiet alert, revoke
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const crypto = require("crypto");
const request = require("supertest");

const SECRET = "test-app-secret";
process.env.WHATSAPP_APP_SECRET = SECRET; // read by server.js at load time
process.env.WHATSAPP_VERIFY_TOKEN = "verify-me";

const { createHarness, closeHarness } = require("../harness/app");
const Intake = require("../../services/leadIntake");

jest.setTimeout(60000);

const PAGE = "109876543210";
const TOKEN = "EAAB" + "x".repeat(40) + "WXYZ";

let h;
let leads; // leadgen id → Graph lead body (or an error status number)
let calls; // every Graph call: "METHOD path"
let subscribedFields;
let proofs; // the appsecret_proof of every Graph call
const fetchStub = async (url, { method = "GET" } = {}) => {
  const u = new URL(url);
  const path = u.pathname.replace(/^\/v[\d.]+\//, "");
  calls.push(`${method} ${path}`);
  proofs.push(u.searchParams.get("appsecret_proof"));
  const reply = (status, json) => ({ ok: status < 400, status, json: async () => json });
  if (u.searchParams.get("access_token") !== TOKEN) return reply(400, { error: { code: 190, message: "bad token" } });
  if (path === PAGE && method === "GET") return reply(200, { name: "Hyde Realty", id: PAGE });
  if (path === `${PAGE}/subscribed_apps` && method === "POST") {
    subscribedFields = u.searchParams.get("subscribed_fields");
    return reply(200, { success: true });
  }
  if (path === `${PAGE}/subscribed_apps` && method === "GET") return reply(200, { data: subscribedFields ? [{ id: "1", subscribed_fields: [subscribedFields] }] : [] });
  if (path === `${PAGE}/subscribed_apps` && method === "DELETE") {
    subscribedFields = null;
    return reply(200, { success: true });
  }
  if (method === "GET" && leads[path]?.__err) return reply(leads[path].status || 400, { error: leads[path].__err });
  if (method === "GET" && typeof leads[path] === "function") return leads[path]();
  if (method === "GET" && leads[path]) return typeof leads[path] === "number" ? reply(leads[path], { error: { code: 100 } }) : reply(200, leads[path]);
  return reply(404, { error: { code: 100 } });
};

beforeEach(async () => {
  h = await createHarness();
  leads = {};
  calls = [];
  proofs = [];
  subscribedFields = null;
  jest.spyOn(globalThis, "fetch").mockImplementation((...a) => fetchStub(...a));
});
afterEach(() => jest.restoreAllMocks());
afterAll(closeHarness);

const connect = (over = {}) => Intake.create(h.pool, h.AGENCY_A, { name: "Facebook ads", source: "Facebook", pageId: PAGE, pageToken: TOKEN, ...over }, { fetch: fetchStub });
const sign = (raw) => "sha256=" + crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
const rawOf = (changes) => JSON.stringify({ object: "page", entry: [{ id: PAGE, time: 1, changes }] });
const hook = (changes, { signed = true } = {}) => {
  const raw = rawOf(changes);
  const r = request(h.app.app).post("/webhook/leadgen").set("Content-Type", "application/json");
  if (signed) r.set("X-Hub-Signature-256", sign(raw));
  return r.send(raw);
};
const change = (id, over = {}) => ({ field: "leadgen", value: { leadgen_id: id, page_id: PAGE, form_id: "f1", ad_id: "a1", created_time: 1, ...over } });
const metaLead = (id = "111", over = {}) => ({
  id,
  created_time: "2026-10-28T10:00:00+0200",
  platform: "ig",
  campaign_name: "Hyde Park Oct",
  field_data: [
    { name: "full_name", values: ["Mona Adel"] },
    { name: "phone_number", values: ["p:+201011112222"] },
    { name: "متى_تريد_الشراء؟", values: ["خلال 3 شهور"] }
  ],
  ...over
});

describe("create, test and revoke", () => {
  test("create checks the token, stores the Page name and subscribes leadgen; the token is never returned", async () => {
    const r = await connect();
    expect(r.intake).toMatchObject({ page_id: PAGE, page_name: "Hyde Realty", token_hint: "WXYZ" });
    expect(r.intake.page_token).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(subscribedFields).toBe("leadgen");
    expect(calls).toEqual([`GET ${PAGE}`, `POST ${PAGE}/subscribed_apps`]);
    expect((await Intake.listForAgency(h.pool, h.AGENCY_A))[0].page_token).toBeUndefined();
  });

  test("create errors: fields, quiet days, unknown agency, bad token, duplicate Page", async () => {
    expect((await connect({ pageId: "abc" })).error).toBe("fields");
    expect((await connect({ pageToken: "" })).error).toBe("fields");
    expect((await connect({ quietDays: 99 })).error).toBe("quiet_days");
    expect((await Intake.create(h.pool, "c0000000-0000-0000-0000-00000000000c", { name: "x", source: "y", pageId: PAGE, pageToken: TOKEN }, { fetch: fetchStub })).error).toBe("not_found");
    expect((await connect({ pageToken: "z".repeat(30) })).error).toBe("page_token");
    expect(await h.query("SELECT 1 FROM lead_intakes")).toHaveLength(0);
    expect((await connect()).intake).toBeTruthy();
    expect((await connect()).error).toBe("duplicate");
  });

  test("create reports a failed subscription", async () => {
    const failing = async (url, o) => (o?.method === "POST" ? { ok: false, status: 403, json: async () => ({ error: { code: 200 } }) } : fetchStub(url, o));
    expect((await Intake.create(h.pool, h.AGENCY_A, { name: "x", source: "Facebook", pageId: PAGE, pageToken: TOKEN }, { fetch: failing })).error).toBe("subscribe");
  });

  test("test button re-checks token and subscription, saves nothing; revoke unsubscribes and forgets the token", async () => {
    const { intake } = await connect();
    expect(await Intake.testIntake(h.pool, intake.id, { fetch: fetchStub })).toMatchObject({ ok: true, name: "Hyde Realty" });
    subscribedFields = null;
    expect(await Intake.testIntake(h.pool, intake.id, { fetch: fetchStub })).toMatchObject({ ok: false, error: "not_subscribed" });
    await h.query("UPDATE lead_intakes SET page_token = 'z' WHERE id = $1", [intake.id]);
    expect((await Intake.testIntake(h.pool, intake.id, { fetch: fetchStub })).error).toBe("page_token");
    await h.query("UPDATE lead_intakes SET page_token = $2 WHERE id = $1", [intake.id, TOKEN]);
    expect(await h.query("SELECT 1 FROM leads")).toHaveLength(0);
    expect(await h.query("SELECT 1 FROM lead_intake_log")).toHaveLength(0);
    subscribedFields = "leadgen";
    calls = [];
    expect((await Intake.revoke(h.pool, intake.id, { fetch: fetchStub })).intake.revoked_at).toBeTruthy();
    expect(calls).toContain(`DELETE ${PAGE}/subscribed_apps`);
    expect((await h.query("SELECT page_token FROM lead_intakes"))[0].page_token).toBeNull();
    expect((await Intake.revoke(h.pool, intake.id, { fetch: fetchStub })).error).toBe("not_found");
    expect((await Intake.testIntake(h.pool, intake.id, { fetch: fetchStub })).error).toBe("not_found");
  });
});

describe("webhook", () => {
  test("GET verify echoes the challenge for the right token only", async () => {
    const good = await request(h.app.app).get("/webhook/leadgen").query({ "hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "12345" });
    expect(good.status).toBe(200);
    expect(good.text).toBe("12345");
    expect((await request(h.app.app).get("/webhook/leadgen").query({ "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "1" })).status).toBe(403);
  });

  test("a bad or missing signature is 401 and nothing is fetched", async () => {
    await connect();
    calls = [];
    leads["111"] = metaLead();
    expect((await hook([change("111")], { signed: false })).status).toBe(401);
    const bad = await request(h.app.app).post("/webhook/leadgen").set("Content-Type", "application/json").set("X-Hub-Signature-256", "sha256=" + "0".repeat(64)).send(rawOf([change("111")]));
    expect(bad.status).toBe(401);
    expect(calls).toHaveLength(0);
    expect(await h.query("SELECT 1 FROM leads")).toHaveLength(0);
  });

  test("a leadgen: Instagram source, campaign and answers in notes, next broker in the round robin; the same leadgen id twice is taken once", async () => {
    await connect();
    leads["111"] = metaLead();
    expect((await hook([change("111")])).status).toBe(200);
    const [lead] = await h.query("SELECT * FROM leads WHERE phone_e164 = '+201011112222'");
    expect(lead).toMatchObject({ name: "Mona Adel", source: "Instagram", stage: "new", created_by_broker_id: null });
    expect(lead.notes).toContain("Campaign: Hyde Park Oct");
    expect(lead.notes).toContain("خلال 3 شهور");
    expect(lead.assigned_broker_id).toBeTruthy();
    expect((await hook([change("111")])).status).toBe(200);
    expect(await h.query("SELECT 1 FROM leads")).toHaveLength(1);
    const log = await Intake.log(h.pool, h.AGENCY_A);
    expect(log.map((g) => g.outcome)).toEqual(["repeat", "created"]);
    expect(log[1].phone_tail).toBe("2222");
    expect(JSON.stringify(log)).not.toContain("1011112222");
    expect(JSON.stringify(log)).not.toContain(TOKEN);
  });

  test("two leads in one webhook go to different brokers in turn", async () => {
    await connect();
    leads["111"] = metaLead("111");
    leads["222"] = metaLead("222", { field_data: [{ name: "full_name", values: ["Sara"] }, { name: "phone_number", values: ["+201055556666"] }] });
    await hook([change("111"), change("222")]);
    const rows = await h.query("SELECT assigned_broker_id FROM leads");
    expect(rows).toHaveLength(2);
    expect(rows[0].assigned_broker_id).not.toBe(rows[1].assigned_broker_id);
  });

  test("a Page with no intake is ignored and logs nothing; a stopped intake too", async () => {
    leads["111"] = metaLead();
    expect((await hook([change("111", { page_id: "999999999" })])).status).toBe(200);
    const { intake } = await connect();
    await Intake.revoke(h.pool, intake.id, { fetch: fetchStub });
    expect((await hook([change("111")])).status).toBe(200);
    expect(await h.query("SELECT 1 FROM lead_intake_log")).toHaveLength(0);
    expect(await h.query("SELECT 1 FROM leads")).toHaveLength(0);
  });

  test("a Graph failure is logged as an error and the webhook still answers 200", async () => {
    await connect();
    leads["333"] = 500;
    expect((await hook([change("333")])).status).toBe(200);
    const log = await Intake.log(h.pool, h.AGENCY_A);
    expect(log[0]).toMatchObject({ outcome: "error", external_id: "333" });
    expect(log[0].detail).toContain("graph 500");
    expect(await h.query("SELECT 1 FROM leads")).toHaveLength(0);
  });

  test("other fields and other objects are acknowledged and ignored", async () => {
    await connect();
    calls = [];
    expect((await hook([{ field: "feed", value: {} }])).status).toBe(200);
    const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    expect((await request(h.app.app).post("/webhook/leadgen").set("Content-Type", "application/json").set("X-Hub-Signature-256", sign(raw)).send(raw)).status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  test("the same phone again (a new form fill) merges into the lead and tells its broker; the intake source fills a missing platform", async () => {
    await connect({ source: "Website" });
    leads["1"] = { id: "1", field_data: [{ name: "full_name", values: ["Karim"] }, { name: "phone_number", values: ["01022223333"] }] };
    leads["2"] = { id: "2", field_data: [{ name: "full_name", values: ["Karim F"] }, { name: "phone_number", values: ["+201022223333"] }, { name: "message", values: ["Still available?"] }] };
    await hook([change("1")]);
    await hook([change("2")]);
    const log = await Intake.log(h.pool, h.AGENCY_A);
    expect(log.map((g) => g.outcome)).toEqual(["merged", "created"]);
    const [lead] = await h.query("SELECT source, assigned_broker_id FROM leads");
    expect(lead.source).toBe("Website");
    const notes = await h.query("SELECT title FROM notifications WHERE broker_id = $1 AND title LIKE '%🔁%'", [lead.assigned_broker_id]);
    expect(notes).toHaveLength(1);
    expect(await Intake.sourcesFor(h.pool, h.AGENCY_A)).toContain("Website");
  });

  test("a bad phone is logged as invalid and keeps no lead", async () => {
    await connect();
    leads["9"] = { id: "9", field_data: [{ name: "full_name", values: ["x"] }, { name: "phone_number", values: ["123"] }] };
    await hook([change("9")]);
    expect((await Intake.log(h.pool, h.AGENCY_A))[0].outcome).toBe("invalid");
    expect(await h.query("SELECT 1 FROM leads")).toHaveLength(0);
  });
});

const ErrorReports = require("../../lib/errorReports");
const Notifications = require("../../lib/notifications");
const proofOf = (t) => crypto.createHmac("sha256", SECRET).update(t).digest("hex");
const hookNow = (id) => Intake.handleLeadgen(h.pool, change(id), { fetch: fetchStub, retryMs: 0 });

describe("token at rest", () => {
  test("the token is stored encrypted, never in the clear, and every Graph call carries appsecret_proof", async () => {
    const { intake } = await connect();
    const [row] = await h.query("SELECT page_token FROM lead_intakes WHERE id = $1", [intake.id]);
    expect(row.page_token).toMatch(/^v1:/);
    expect(row.page_token).not.toContain(TOKEN);
    leads["111"] = metaLead();
    await hook([change("111")]);
    await Intake.testIntake(h.pool, intake.id, { fetch: fetchStub });
    expect(proofs.length).toBeGreaterThanOrEqual(5);
    expect(new Set(proofs)).toEqual(new Set([proofOf(TOKEN)]));
    expect(await h.query("SELECT 1 FROM leads")).toHaveLength(1);
  });

  test("a legacy plain token in the database still works", async () => {
    const { intake } = await connect();
    await h.query("UPDATE lead_intakes SET page_token = $2 WHERE id = $1", [intake.id, TOKEN]);
    leads["111"] = metaLead();
    await hook([change("111")]);
    expect(await h.query("SELECT 1 FROM leads")).toHaveLength(1);
  });

  test("production without TOKEN_ENCRYPTION_KEY refuses to connect (and to update a token)", async () => {
    const config = { isProd: true, security: { tokenEncryptionKey: "" } };
    calls = [];
    expect((await Intake.create(h.pool, h.AGENCY_A, { name: "x", source: "Facebook", pageId: PAGE, pageToken: TOKEN }, { fetch: fetchStub, config })).error).toBe("encryption_key");
    expect(await h.query("SELECT 1 FROM lead_intakes")).toHaveLength(0);
    const { intake } = await connect();
    calls = [];
    expect((await Intake.updateToken(h.pool, intake.id, TOKEN, { fetch: fetchStub, config })).error).toBe("encryption_key");
    expect(calls).toHaveLength(0);
  });
});

describe("Graph errors", () => {
  let alert;
  beforeEach(() => {
    alert = jest.spyOn(ErrorReports, "alertOwner").mockResolvedValue(true);
  });
  const notices = (id) => h.query("SELECT broker_id, title, body, url FROM notifications WHERE dedupe_key LIKE $1", [`intake_disconnected:${id}:%`]);

  test.each([
    [{ code: 190, error_subcode: 460 }, "password_changed"],
    [{ code: 190, error_subcode: 492 }, "removed"],
    [{ code: 190, error_subcode: 459 }, "checkpoint"],
    [{ code: 190, error_subcode: 463 }, "token_invalid"],
    [{ code: 190, error_subcode: 467 }, "token_invalid"],
    [{ code: 190 }, "token_invalid"],
    [{ code: 200 }, "permission"],
    [{ code: 10 }, "permission"],
    [{ code: 283 }, "permission"]
  ])("%j disconnects the intake with reason %s and alerts once", async (err, reason) => {
    const { intake } = await connect();
    leads["1"] = { __err: err, status: 400 };
    leads["2"] = { __err: err, status: 400 };
    await hookNow("1");
    const [row] = await h.query("SELECT status, disconnect_reason, disconnected_at, last_error_code FROM lead_intakes WHERE id = $1", [intake.id]);
    expect(row).toMatchObject({ status: "disconnected", disconnect_reason: reason });
    expect(row.disconnected_at).toBeTruthy();
    expect(row.last_error_code).toContain(String(err.code));
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][0]).toContain("disconnected");
    expect(alert.mock.calls[0][0]).not.toContain(TOKEN);
    const managers = await Notifications.managersOf(h.pool, h.AGENCY_A);
    const n = await notices(intake.id);
    expect(managers.length).toBeGreaterThan(0);
    expect(n).toHaveLength(managers.length);
    expect(n[0].url).toBe("/app/sources");
    expect(n.map((x) => x.title + x.body).join(" ")).toMatch(/WehdatHub/);
    // a second failing lead: no Graph call, no new alert
    calls = [];
    await hookNow("2");
    expect(calls).toHaveLength(0);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(await notices(intake.id)).toHaveLength(managers.length);
    const log = await Intake.log(h.pool, h.AGENCY_A);
    expect(log[0]).toMatchObject({ outcome: "error", external_id: "2" });
    expect(log[0].detail).toContain("disconnected");
  });

  test("the webhook still answers 200 for a disconnected intake and the quiet check skips it", async () => {
    const { intake } = await connect({ quietDays: 1 });
    leads["1"] = { __err: { code: 190, error_subcode: 460 }, status: 400 };
    expect((await hook([change("1")])).status).toBe(200);
    expect((await hook([change("2")])).status).toBe(200);
    expect((await Intake.quietCheck(h.pool, { now: new Date(Date.now() + 5 * 86400000) })).counts.quiet).toBe(0);
    expect((await h.query("SELECT status FROM lead_intakes WHERE id = $1", [intake.id]))[0].status).toBe("disconnected");
  });

  test("a temporary error is retried once, then logged; the intake stays active and nobody is alerted", async () => {
    const { intake } = await connect();
    leads["7"] = { __err: { code: 2 }, status: 500 };
    calls = [];
    await hookNow("7");
    expect(calls.filter((c) => c === "GET 7")).toHaveLength(2);
    const [row] = await h.query("SELECT status, last_error_code, last_error_at FROM lead_intakes WHERE id = $1", [intake.id]);
    expect(row.status).toBe("active");
    expect(row.last_error_code).toBe("2");
    expect((await Intake.log(h.pool, h.AGENCY_A))[0]).toMatchObject({ outcome: "error", external_id: "7" });
    expect(alert).not.toHaveBeenCalled();
    // rate limit codes too, and a network failure
    leads["8"] = { __err: { code: 4 }, status: 400 };
    await hookNow("8");
    const netFail = async (url, o) => (new URL(url).pathname.endsWith("/9") ? Promise.reject(new Error("boom")) : fetchStub(url, o));
    await Intake.handleLeadgen(h.pool, change("9"), { fetch: netFail, retryMs: 0 });
    expect((await h.query("SELECT status FROM lead_intakes WHERE id = $1", [intake.id]))[0].status).toBe("active");
    expect(alert).not.toHaveBeenCalled();
  });

  test("a temporary error that clears on the retry saves the lead", async () => {
    await connect();
    let n = 0;
    leads["5"] = () => (++n === 1 ? { ok: false, status: 503, json: async () => ({ error: { code: 2 } }) } : { ok: true, status: 200, json: async () => metaLead("5") });
    await hookNow("5");
    expect(n).toBe(2);
    expect(await h.query("SELECT 1 FROM leads")).toHaveLength(1);
  });

  test("Test on a dead token disconnects (once); Update token reconnects, replaces the token and subscribes", async () => {
    const { intake } = await connect();
    await h.query("UPDATE lead_intakes SET page_token = 'z' WHERE id = $1", [intake.id]);
    expect((await Intake.testIntake(h.pool, intake.id, { fetch: fetchStub })).error).toBe("page_token");
    expect((await Intake.testIntake(h.pool, intake.id, { fetch: fetchStub })).error).toBe("page_token");
    expect(alert).toHaveBeenCalledTimes(1);
    expect((await h.query("SELECT status FROM lead_intakes"))[0].status).toBe("disconnected");
    expect((await Intake.updateToken(h.pool, intake.id, "z".repeat(30), { fetch: fetchStub })).error).toBe("page_token");
    expect((await Intake.updateToken(h.pool, intake.id, "short", { fetch: fetchStub })).error).toBe("fields");
    subscribedFields = null;
    const r = await Intake.updateToken(h.pool, intake.id, TOKEN, { fetch: fetchStub });
    expect(r.intake).toMatchObject({ status: "active", disconnect_reason: null, token_hint: "WXYZ" });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(subscribedFields).toBe("leadgen");
    const [row] = await h.query("SELECT page_token FROM lead_intakes WHERE id = $1", [intake.id]);
    expect(row.page_token).toMatch(/^v1:/);
    leads["3"] = metaLead("3");
    await hookNow("3");
    expect(await h.query("SELECT 1 FROM leads")).toHaveLength(1);
    // a later disconnect alerts again (a new transition)
    leads["4"] = { __err: { code: 190, error_subcode: 492 }, status: 400 };
    await hookNow("4");
    expect(alert).toHaveBeenCalledTimes(2);
  });

  test("a working Test on a disconnected intake flips it back to active", async () => {
    const { intake } = await connect();
    await h.query("UPDATE lead_intakes SET status = 'disconnected', disconnect_reason = 'token_invalid', disconnected_at = now() WHERE id = $1", [intake.id]);
    expect((await Intake.testIntake(h.pool, intake.id, { fetch: fetchStub })).ok).toBe(true);
    expect((await h.query("SELECT status, disconnect_reason FROM lead_intakes"))[0]).toMatchObject({ status: "active", disconnect_reason: null });
  });
});

describe("owner tab", () => {
  const { signIn } = require("../harness/web");
  const { resetConfig } = require("../../config");
  afterEach(() => {
    delete process.env.OWNER_BROKER_IDS;
    resetConfig();
  });

  test("shows counts, status, reasons and the newest log without a token or a phone; the agency sees a red banner", async () => {
    process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
    resetConfig();
    jest.spyOn(ErrorReports, "alertOwner").mockResolvedValue(true);
    await connect();
    leads["1"] = metaLead("1");
    leads["2"] = { id: "2", field_data: [{ name: "full_name", values: ["x"] }, { name: "phone_number", values: ["123"] }] };
    await hook([change("1")]);
    await hook([change("1")]);
    await hook([change("2")]);
    const { agent, csrf } = await signIn(h, "admin");
    let page = (await agent.get("/app/owner")).text;
    expect(page).toContain("data-intake-summary");
    expect(page).toContain("Facebook leads");
    expect(page).toContain("Hyde Realty");
    expect(page).toMatch(/data-status="active"/);
    expect(page).toContain("1 / 1 / 1"); // 24h / 7d / 30d
    expect(page).not.toContain(TOKEN);
    expect(page).not.toContain("1011112222");
    expect(page).not.toMatch(/data-intake-banner/);
    const t = await Intake.tracking(h.pool);
    expect(t.summary).toMatchObject({ active: 1, disconnected: 0, leads30: 1, failed30: 1 });
    expect(t.rows[0]).toMatchObject({ repeats_30d: 1, leads_30d: 1 });
    expect(t.log).toHaveLength(3);
    leads["3"] = { __err: { code: 190, error_subcode: 460 }, status: 400 };
    await hook([change("3")]);
    page = (await agent.get("/app/owner")).text;
    expect(page).toMatch(/data-status="disconnected"/);
    expect(page).toMatch(/data-intake-banner/);
    expect(page).toContain("password");
    expect(page).not.toContain(TOKEN);
    const sources = (await agent.get("/app/sources")).text;
    expect(sources).toMatch(/data-intake-banner/);
    expect(sources).toContain("Ask WehdatHub support to reconnect the Page");
    const [intake] = await h.query("SELECT id FROM lead_intakes");
    const done = await agent.post(`/app/owner/intake/${intake.id}/token`).type("form").send({ _csrf: csrf, page_token: TOKEN });
    expect(done.status).toBe(200);
    expect(done.text).not.toMatch(/data-intake-banner/);
    expect(done.text).not.toContain(TOKEN);
    expect((await h.query("SELECT status FROM lead_intakes"))[0].status).toBe("active");
    expect((await agent.post(`/app/owner/intake/${intake.id}/token`).type("form").send({ _csrf: csrf, page_token: "short" })).status).toBe(400);
  });
});

test("a quiet intake alerts the managers once until a lead arrives", async () => {
  const { intake } = await connect({ name: "Ads", quietDays: 2 });
  const later = new Date(Date.now() + 3 * 86400000);
  expect((await Intake.quietCheck(h.pool, { now: later })).counts.quiet).toBe(1);
  expect((await Intake.quietCheck(h.pool, { now: new Date(later.getTime() + 3600000) })).counts.quiet).toBe(0);
  const alerts = await h.query("SELECT 1 FROM notifications WHERE dedupe_key LIKE $1", [`intake_quiet:${intake.id}:%`]);
  expect(alerts.length).toBeGreaterThan(0);
  expect(require("../../lib/jobs").buildJobs().map((j) => j.name)).toContain("intake_quiet");
});

describe("pages", () => {
  const { signIn } = require("../harness/web");
  const { resetConfig } = require("../../config");
  afterEach(() => {
    delete process.env.OWNER_BROKER_IDS;
    resetConfig();
  });

  test("the owner connects a Page (token never shown back), tests it and stops it; managers see the source, its log and the filter", async () => {
    process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
    resetConfig();
    const { agent, csrf } = await signIn(h, "admin");
    const made = await agent.post("/app/owner/intake").type("form").send({ _csrf: csrf, agency: h.AGENCY_A, name: "Facebook ads", source: "Facebook", page_id: PAGE, page_token: TOKEN, quiet_days: "3" });
    expect(made.status).toBe(200);
    expect(made.text).toContain("Hyde Realty");
    expect(made.text).not.toContain(TOKEN);
    expect(made.text).toContain("WXYZ");
    expect(made.text).toContain("/webhook/leadgen");
    expect(made.text).not.toMatch(/make\.com|Make /i);
    const [intake] = await h.query("SELECT id FROM lead_intakes");
    expect((await agent.post(`/app/owner/intake/${intake.id}/test`).type("form").send({ _csrf: csrf })).text).toMatch(/Test passed|التجربة نجحت/);
    leads["55"] = { id: "55", platform: "fb", field_data: [{ name: "full_name", values: ["Hany"] }, { name: "phone_number", values: ["01033334444"] }] };
    await hook([change("55")]);
    const sources = await agent.get("/app/sources");
    expect(sources.text).toContain('id="intake"');
    expect(sources.text).toMatch(/data-intake-log/);
    expect(sources.text).not.toContain("01033334444");
    expect(sources.text).not.toContain(TOKEN);
    const bad = await agent.post("/app/owner/intake").type("form").send({ _csrf: csrf, agency: h.AGENCY_A, name: "x", source: "Facebook", page_id: PAGE, page_token: "short" });
    expect(bad.status).toBe(400);
    await agent.post(`/app/owner/intake/${intake.id}/revoke`).type("form").send({ _csrf: csrf });
    leads["56"] = { id: "56", field_data: [{ name: "phone_number", values: ["01033335555"] }] };
    await hook([change("56")]);
    expect(await h.query("SELECT 1 FROM leads WHERE phone_e164 = '+201033335555'")).toHaveLength(0);
  });

  test("an agency's own sources show in the leads filter", async () => {
    await connect({ name: "Site", source: "Website form" });
    const { agent } = await signIn(h, "admin");
    expect((await agent.get("/app/leads")).text).toContain('<option value="Website form"');
    expect((await agent.get("/app/leads/new")).text).toContain('<option value="Website form"');
  });
});
