// tests/web/settings-one-place.test.js — One Settings area (plan section 9): Me, Agency, Plan and billing. A role sees the
// sections it may use; the agency forms post to their old routes and come back here; the usage page points here.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("owner");
});
afterAll(closeHarness);

const get = async (who) => (await (await signIn(h, who)).agent.get("/app/settings?lang=en")).text;
const sections = (text) => [...text.matchAll(/data-settings-section="([a-z]+)"/g)].map((m) => m[1]);

test("the owner sees all three sections and the section links", async () => {
  const text = await get("owner");
  expect(sections(text)).toEqual(["me", "agency", "plan"]);
  expect(text).toMatch(/data-settings-nav/);
  expect(text).toMatch(/href="#agency"/);
  expect(text).toMatch(/href="#plan"/);
});

test("a manager sees Me and Agency, not Plan and billing", async () => {
  const text = await get("admin");
  expect(sections(text)).toEqual(["me", "agency"]);
  expect(text).not.toMatch(/href="#plan"/);
  expect(text).not.toMatch(/data-plan-summary/);
});

test("a broker sees Me only: no section links, no agency forms", async () => {
  const text = await get("broker");
  expect(sections(text)).toEqual(["me"]);
  expect(text).not.toMatch(/data-settings-nav/);
  for (const k of ["data-fx-rates", "data-agency-caps", 'id="data-security"', 'id="broker-edit"']) expect(text).not.toContain(k);
});

test("Me has language, the theme buttons, notifications, quiet hours and passkeys", async () => {
  const text = await get("broker");
  expect(text).toMatch(/name="lang"/);
  expect(text).toMatch(/data-theme-set="dark"/);
  expect(text).toMatch(/name="quiet_start"/);
  expect(text).not.toMatch(/id="draft-style"/);
});

test("Agency has the logo, code letters, rates, private details and the brokers switch, each owner-only one read only for a manager", async () => {
  const owner = await get("owner");
  for (const k of ["data-fx-rates", 'name="code_prefix"', 'name="USD"', 'name="scope"', 'role="switch" name="allowed"', "data-ai-usage-link"]) expect(owner).toContain(k);
  expect(owner).toMatch(/name="return" value="settings"/);
  expect(owner).not.toMatch(/name="scope" value="all" disabled/);
  const manager = await get("admin");
  // A manager sees only what they may change: no logo, quota, data security or broker switches.
  for (const k of ['id="brand"', 'name="monthly"', 'name="daily_cap"', 'name="scope"', 'role="switch" name="allowed"']) expect(manager).not.toContain(k);
  expect(manager).toContain('name="code_prefix"'); // managers may set these
  expect(manager).toContain("data-fx-rates");
  expect(owner).toContain('id="brand"');
  expect(owner).not.toContain('name="monthly"'); // the WhatsApp credits form is gone (Telegram is free)
});

test("Settings sections are tabs in the brand colour", async () => {
  const text = await get("owner");
  expect(text).toMatch(/role="tablist"/);
  expect(text).toMatch(/<a href="#me" role="tab" aria-selected="true">/);
});

test("a manager's quota post changes the code letters only", async () => {
  await h.query("UPDATE agencies SET wa_credits_monthly = 1000 WHERE id = $1", [h.AGENCY_A]);
  const s = await signIn(h, "admin");
  await s.agent.post("/app/usage/agency").type("form").send({ _csrf: s.csrf, monthly: "9000", code_prefix: "QQ" });
  const [a] = await h.query("SELECT code_prefix, wa_credits_monthly FROM agencies WHERE id = $1", [h.AGENCY_A]);
  expect(a).toMatchObject({ code_prefix: "QQ", wa_credits_monthly: 1000 });
});

test("a notification kind that is off shows its channels and frequency off", async () => {
  await h.query("UPDATE brokers SET notify_prefs = $2::jsonb WHERE id = $1", [h.BROKERS.broker.id, JSON.stringify({ on: { match: false } })]);
  const text = await get("broker");
  const row = text.split('data-notify="match"')[1].split('data-notify="')[0];
  expect(row).toMatch(/name="ch_match"[^>]* disabled/);
  expect(row).toMatch(/name="fq_match"[^>]* disabled/);
});

test("the agency forms come back to Settings when asked to", async () => {
  const s = await signIn(h, "owner");
  const post = (path, body) => s.agent.post(path).type("form").send({ _csrf: s.csrf, return: "settings", ...body });
  let r = await post("/app/usage/agency", { monthly: "5000", code_prefix: "ZZ" });
  expect(r.status).toBe(303);
  expect(r.headers.location).toMatch(/^\/app\/settings\?saved=1#agency-caps/);
  r = await post("/app/usage/fx", { USD: "50", EUR: "55" });
  expect(r.headers.location).toMatch(/^\/app\/settings\?saved=1#fx/);
  r = await post("/app/usage/fx", { USD: "abc", EUR: "" });
  expect(r.headers.location).toMatch(/^\/app\/settings\?fx=bad#fx/);
  r = await post("/app/dashboard/secret-details", { scope: "all" });
  expect(r.headers.location).toMatch(/^\/app\/settings\?saved=1#data-security/);
  r = await post("/app/dashboard/brokers-edit-units", { allowed: "on" });
  expect(r.headers.location).toMatch(/^\/app\/settings\?saved=1#broker-edit/);
  // Without the field they still go where they always did.
  r = await s.agent.post("/app/usage/agency").type("form").send({ _csrf: s.csrf, monthly: "5000", code_prefix: "ZZ" });
  expect(r.headers.location).toMatch(/^\/app\/usage\?saved=1/);
  const [a] = await h.query("SELECT code_prefix FROM agencies WHERE id = $1", [h.AGENCY_A]);
  expect(a).toMatchObject({ code_prefix: "ZZ" });
});

test("a manager cannot change what only the owner may, even from Settings", async () => {
  const s = await signIn(h, "admin");
  const r = await s.agent.post("/app/dashboard/secret-details").type("form").send({ _csrf: s.csrf, return: "settings", scope: "all" });
  expect(r.status).toBe(403);
});

test("the usage page now points to Settings for the agency forms", async () => {
  const s = await signIn(h, "admin");
  const text = (await s.agent.get("/app/usage?lang=en")).text;
  expect(text).toMatch(/data-agency-settings-link/);
  expect(text).not.toContain("data-fx-rates");
  expect(text).not.toContain('name="code_prefix"');
});

test("the owner's Plan section shows the plan and credits with the link to pay", async () => {
  const text = await get("owner");
  expect(text).toMatch(/data-plan-summary/);
  expect(text).toMatch(/AI credits this month: \d+ of \d+/);
  expect(text).toMatch(/href="\/app\/usage#plan"/);
});

test("QA round 4 #95: a bad unit code is refused with the rule, keeps what was typed, shows no Saved, and the old letters stay", async () => {
  await h.query("UPDATE agencies SET code_prefix = 'OK' WHERE id = $1", [h.AGENCY_A]);
  const s = await signIn(h, "admin");
  for (const bad of ["", "AB CD", "N-H", "ABCDE", "أبج", "N1"]) {
    const r = await s.agent.post("/app/usage/agency").type("form").send({ _csrf: s.csrf, return: "settings", code_prefix: bad });
    expect(r.status).toBe(303);
    expect(r.headers.location).toMatch(/codebad=1/);
    expect(r.headers.location).not.toMatch(/saved=1/);
    const page = (await s.agent.get(`${r.headers.location}`.replace("#agency-caps", "") + "&lang=en")).text;
    expect(page).toMatch(/Not saved: use 1 to 4 English letters/);
    expect(page).toContain(`value="${bad.replace(/&/g, "&amp;")}"`);
    expect(page).not.toMatch(/Saved\.<\/p>/);
  }
  expect((await h.query("SELECT code_prefix FROM agencies WHERE id = $1", [h.AGENCY_A]))[0].code_prefix).toBe("OK");
  const good = await s.agent.post("/app/usage/agency").type("form").send({ _csrf: s.csrf, return: "settings", code_prefix: "nh" });
  expect(good.headers.location).toMatch(/saved=1/);
  expect((await h.query("SELECT code_prefix FROM agencies WHERE id = $1", [h.AGENCY_A]))[0].code_prefix).toBe("NH");
});
