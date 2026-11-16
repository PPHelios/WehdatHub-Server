// tests/web/ai-limits-ui.test.js — /app/usage: AI use per person (spec-web.md sections 3, 4, 4b): the owner picks the mode with
// radio buttons, a switch lets managers change it, a manager sees it read only until then, a broker never sees the controls,
// and a non-owner who posts gets a 403. The switch pattern is the same everywhere (web/views/switches.js).
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

const settings = async () => (await h.query("SELECT ai_usage_mode AS mode, ai_user_default_credits AS d, manager_can_edit_ai_settings AS m FROM agencies WHERE id = $1", [h.AGENCY_A]))[0];
const post = (s, path, body) => s.agent.post(path).type("form").send({ _csrf: s.csrf, ...body });

test("the owner sees radio buttons for the mode, a default, a person list and the managers switch", async () => {
  const s = await signIn(h, "owner");
  const text = (await s.agent.get("/app/usage?lang=en")).text;
  expect(text).toMatch(/data-ai-limits/);
  expect(text).toMatch(/<input type="radio" name="ai_mode" value="pool" checked>/);
  expect(text).toMatch(/<input type="radio" name="ai_mode" value="per_user">/);
  expect(text).toMatch(/Shared pool/);
  expect(text).toMatch(/Each person has a limit/);
  expect(text).toMatch(/name="ai_default"/);
  expect(text).toMatch(/name="ov_/);
  expect(text).toMatch(/role="switch" name="allowed"/);
  expect(text).toMatch(/Managers can change AI usage settings/);
});

test("the owner saves one choice: the mode, the default and a person's own limit", async () => {
  const s = await signIn(h, "owner");
  const r = await post(s, "/app/usage/ai-limits", { ai_mode: "per_user", ai_default: "40", [`ov_${h.BROKERS.broker.id}`]: "15", [`ov_${h.BROKERS.colleague.id}`]: "" });
  expect(r.status).toBe(303);
  expect(await settings()).toMatchObject({ mode: "per_user", d: 40 });
  const [b] = await h.query("SELECT ai_user_credits AS c FROM brokers WHERE id = $1", [h.BROKERS.broker.id]);
  expect(b.c).toBe(15);
  const page = (await s.agent.get("/app/usage?lang=en")).text;
  expect(page).toMatch(/<input type="radio" name="ai_mode" value="per_user" checked>/);
  const bad = await post(s, "/app/usage/ai-limits", { ai_mode: "per_user", ai_default: "-3" });
  expect(bad.status).toBe(303);
  expect(bad.headers.location).toMatch(/ai=bad/);
  expect((await settings()).d).toBe(40);
});

test("a broker sees only their own card: no controls, no list, and a post is refused", async () => {
  const s = await signIn(h, "broker");
  const text = (await s.agent.get("/app/usage?lang=en")).text;
  expect(text).toMatch(/data-ai-mine/);
  expect(text).not.toMatch(/data-ai-limits/);
  expect(text).not.toMatch(/name="ai_mode"/);
  expect((await post(s, "/app/usage/ai-limits", { ai_mode: "per_user" })).status).toBe(403);
  expect((await post(s, "/app/usage/ai-limits/managers", { allowed: "on" })).status).toBe(403);
  expect((await settings()).mode).toBe("pool");
});

test("a manager sees the settings read only, with the owner's line; the owner's switch lets them change it", async () => {
  const s = await signIn(h, "admin");
  let text = (await s.agent.get("/app/usage?lang=en")).text;
  expect(text).toMatch(/data-ai-limits-readonly/);
  expect(text).toMatch(/The agency owner has not allowed managers to change this/);
  expect(text).toMatch(/<input type="radio" name="ai_mode" value="pool" checked disabled>/);
  expect(text).not.toMatch(/data-ai-managers-form/);
  expect((await post(s, "/app/usage/ai-limits", { ai_mode: "per_user" })).status).toBe(403);
  expect((await post(s, "/app/usage/ai-limits/managers", { allowed: "on" })).status).toBe(403);

  const owner = await signIn(h, "owner");
  expect((await post(owner, "/app/usage/ai-limits/managers", { allowed: "on" })).status).toBe(303);
  expect((await settings()).m).toBe(true);
  text = (await s.agent.get("/app/usage?lang=en")).text;
  expect(text).toMatch(/data-ai-limits-form/);
  expect(text).not.toMatch(/data-ai-limits-locked/);
  expect((await post(s, "/app/usage/ai-limits", { ai_mode: "per_user", ai_default: "25" })).status).toBe(303);
  expect(await settings()).toMatchObject({ mode: "per_user", d: 25 });
  // The flag itself stays the owner's.
  expect((await post(s, "/app/usage/ai-limits/managers", {})).status).toBe(403);
  // Switching it off (an unchecked switch posts nothing) closes the settings to the manager again.
  expect((await post(owner, "/app/usage/ai-limits/managers", {})).status).toBe(303);
  expect((await settings()).m).toBe(false);
  expect((await post(s, "/app/usage/ai-limits", { ai_mode: "pool" })).status).toBe(403);
});

test("in limit mode a person's card says 'Your AI limit: X this month, used Y'; in pool mode it says the use only", async () => {
  const s = await signIn(h, "broker");
  expect((await s.agent.get("/app/usage?lang=en")).text).toMatch(/data-ai-mode="pool"/);
  await h.query("UPDATE agencies SET ai_usage_mode = 'per_user', ai_user_default_credits = 30 WHERE id = $1", [h.AGENCY_A]);
  const text = (await s.agent.get("/app/usage?lang=en")).text;
  expect(text).toMatch(/data-ai-mode="per_user"/);
  expect(text).toMatch(/Your AI limit: 30 this month, used 0/);
});

test("every change to these settings is in the audit log with who made it", async () => {
  const owner = await signIn(h, "owner");
  await post(owner, "/app/usage/ai-limits", { ai_mode: "per_user", ai_default: "10" });
  await post(owner, "/app/usage/ai-limits/managers", { allowed: "on" });
  const rows = await h.query("SELECT action, broker_id FROM audit_logs WHERE agency_id = $1 AND action IN ('ai_usage_settings', 'manager_can_edit_ai_settings') ORDER BY id", [h.AGENCY_A]);
  expect(rows.map((r) => r.action).sort()).toEqual(["ai_usage_settings", "manager_can_edit_ai_settings"]);
  expect(rows.every((r) => r.broker_id === h.BROKERS.owner.id)).toBe(true);
});

test("the usage API carries the mode, the person's allowance and use (and the people list for managers only)", async () => {
  await h.query("UPDATE agencies SET ai_usage_mode = 'per_user', ai_user_default_credits = 12 WHERE id = $1", [h.AGENCY_A]);
  const Limits = require("../../services/aiUserLimits");
  const mine = await Limits.overview(h.pool, (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.broker.id]))[0]);
  expect(mine).toMatchObject({ mode: "per_user", mine: { allowance: 12, used: 0, remaining: 12 } });
  expect(mine.people).toBeUndefined();
});
