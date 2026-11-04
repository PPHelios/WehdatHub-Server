// tests/web/data-entry.test.js — the data entry role on the website, and the six-digit code sign-in
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn, preOf, csrfOf } = require("../harness/web");
const WebAuth = require("../../lib/webAuth");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
  await h.pool.query("UPDATE brokers SET role = 'data_entry' WHERE id = $1", [h.BROKERS.colleague.id]);
});
afterAll(closeHarness);

test("data entry lands on units and is kept out of leads, owners and imports", async () => {
  const { agent } = await signIn(h, h.BROKERS.colleague);
  const home = await agent.get("/app/");
  expect(home.status).toBe(303);
  expect(home.headers.location).toBe("/app/units");
  expect((await agent.get("/app/units")).status).toBe(200);
  expect((await agent.get("/app/leads")).status).toBe(403);
  expect((await agent.get("/app/owners")).status).toBe(403);
  expect((await agent.get("/app/deals")).status).toBe(403);
});

test("a code typed on the website signs the broker in once", async () => {
  const agent = request.agent(h.app.app);
  const pre = preOf((await agent.get("/app/login")).text);
  const code = await WebAuth.issueLoginCode(h.pool, h.BROKERS.broker);
  const bad = await agent.post("/app/login/code").type("form").send({ _csrf: pre, phone: h.BROKERS.broker.phone, code: "000000" === code ? "111111" : "000000" });
  expect(bad.status).toBe(422);
  const ok = await agent.post("/app/login/code").type("form").send({ _csrf: preOf(bad.text), phone: h.BROKERS.broker.phone, code });
  expect(ok.status).toBe(303);
  const again = await agent.post("/app/login/code").type("form").send({ _csrf: preOf(ok.text) || pre, phone: h.BROKERS.broker.phone, code });
  expect(again.status).toBe(422);
});

test("data entry sees only its own places: no Today or Leads tab, the plus adds a unit, and the More page lists only allowed links", async () => {
  const { agent } = await signIn(h, h.BROKERS.colleague);
  const page = (await agent.get("/app/units")).text;
  expect(page).not.toContain('data-tab="home"');
  expect(page).not.toContain('data-tab="leads"');
  expect(page).toContain('class="fab" href="/app/units/new"');
  const more = (await agent.get("/app/more")).text;
  expect(more).toContain('href="/app/units"');
  expect(more).not.toContain('href="/app/deals"');
  expect(more).not.toContain('href="/app/owner"');
  expect(more).not.toContain('href="/app/leads/import"');
});

test("data entry can create a share link for a unit in its agency", async () => {
  const listing = await h.insertListing({ code: "DE-SHARE-1", broker_id: h.BROKERS.broker.id });
  const { agent } = await signIn(h, h.BROKERS.colleague);
  const csrf = csrfOf((await agent.get("/app/units")).text);
  const res = await agent.post(`/app/units/${listing.code}/share`).type("form").send({ lang: "ar", _csrf: csrf });
  expect(res.status).toBe(200);
  expect(res.text).toContain("DE-SHARE-1");
  const links = await h.query("SELECT count(*)::int AS n FROM share_links WHERE listing_id = $1", [listing.id]);
  expect(links[0].n).toBeGreaterThan(0);
});
