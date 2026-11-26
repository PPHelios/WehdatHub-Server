// tests/security/role-matrix.test.js — The menu and the rights agree, for every role (QA round 3, step 4).
// lib/navSpec.js says which role sees which page; this opens every page with a website path as every role:
// a role that sees the item must get the page (200), a role that does not must be refused (not 200).
// A page a role may open without a menu item is listed in OPEN_WITHOUT_MENU with the reason.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Nav = require("../../lib/navSpec");

jest.setTimeout(600000);

const ROLES = ["broker", "team_lead", "manager", "owner", "data_entry"];

// "role key": why that role may open the page although its menu does not show it.
const OPEN_WITHOUT_MENU = {
  "broker pipeline": "Brokers open their own Kanban board from Leads.",
  "team_lead leadrules": "The Team page opens, but managers' Lead Rules are absent."
};

let h;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

async function as(role) {
  if (role === "owner") {
    await h.seedBroker("owner");
    return signIn(h, "owner");
  }
  await h.query("UPDATE brokers SET role = $2 WHERE id = $1", [h.BROKERS.colleague.id, role]);
  return signIn(h, "colleague");
}

test("every role opens the pages on its menu and is refused the others", async () => {
  // "market" shows only while the owner has switched market analytics on for the agency: tests/web/analytics.test.js covers it.
  const items = Nav.ITEMS.filter((it) => it.web && it.key !== "market" && !it.roles.every((r) => r === "crm"));
  expect(items.length).toBeGreaterThan(20);
  const wrong = [];
  for (const role of ROLES) {
    const { agent } = await as(role);
    for (const it of items) {
      const { key, roles, web } = it;
      const res = await agent.get(web).redirects(key === "portal" && roles.includes(role) ? 1 : 0);
      const sees = roles.includes(role);
      if (role === "team_lead" && key === "leadrules") expect(res.text).not.toContain("data-lead-rules");
      if (sees && res.status !== 200) wrong.push(`${role} sees "${key}" (${web}) but gets ${res.status}`);
      if (!sees && res.status === 200 && !OPEN_WITHOUT_MENU[`${role} ${key}`]) wrong.push(`${role} does not see "${key}" (${web}) but it opens`);
    }
  }
  expect(wrong).toEqual([]);
});

test("a role change and a deactivation take effect at once, on the website and the app", async () => {
  const request = require("supertest");
  const WebAuth = require("../../lib/webAuth");
  const id = h.BROKERS.colleague.id;
  await h.query("UPDATE brokers SET role = 'manager', is_active = true WHERE id = $1", [id]);
  const { agent } = await signIn(h, "colleague");
  const code = await WebAuth.issueLoginCode(h.pool, { id, agency_id: h.BROKERS.colleague.agency_id });
  const token = (await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: h.BROKERS.colleague.phone, code })).body.token;
  const app = (p) => request(h.app.app).get(`/api/v1${p}`).set("Authorization", `Bearer ${token}`);
  expect((await agent.get("/app/dashboard").redirects(0)).status).toBe(200);
  expect((await app("/team/former")).status).toBe(200);

  await h.query("UPDATE brokers SET role = 'broker' WHERE id = $1", [id]);
  expect((await agent.get("/app/dashboard").redirects(0)).status).not.toBe(200);
  expect((await app("/team/former")).status).toBe(403);

  await h.query("UPDATE brokers SET is_active = false WHERE id = $1", [id]);
  expect((await agent.get("/app/units").redirects(0)).status).not.toBe(200);
  expect((await app("/units")).status).toBe(401);
  await h.query("UPDATE brokers SET is_active = true WHERE id = $1", [id]);
});

test("below the agency tier a locked page is refused on the website and the app (403 plan_feature); a pilot keeps every page", async () => {
  const request = require("supertest");
  const WebAuth = require("../../lib/webAuth");
  const aid = h.BROKERS.colleague.agency_id;
  const forget = () => { require("../../lib/planGuard").forget(aid); require("../../lib/workspace").forgetAll(); };
  const { agent } = await as("owner");
  const owner = h.BROKERS.owner || h.BROKERS.colleague;
  const code = await WebAuth.issueLoginCode(h.pool, { id: owner.id, agency_id: owner.agency_id });
  const token = (await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: owner.phone, code })).body.token;
  const api = (p) => request(h.app.app).get(`/api/v1${p}`).set("Authorization", `Bearer ${token}`);
  try {
    expect((await agent.get("/app/sources").redirects(0)).status).toBe(200); // pilot: unchanged
    await h.query("UPDATE agencies SET pilot = false, plan = 'team', paid_until = now() + interval '30 days' WHERE id = $1", [aid]);
    forget();
    const res = await agent.get("/app/sources").redirects(0);
    expect(res.status).toBe(403);
    expect(res.text).toContain("data-plan-feature");
    expect((await agent.get("/app/leads").redirects(0)).status).toBe(200);
    const r = await api("/sources");
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: "plan_feature" });
    expect(r.body.message).toBeTruthy();
  } finally {
    await h.query("UPDATE agencies SET pilot = true WHERE id = $1", [aid]);
    forget();
  }
  expect((await agent.get("/app/sources").redirects(0)).status).toBe(200);
});
