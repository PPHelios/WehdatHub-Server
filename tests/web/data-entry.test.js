// tests/web/data-entry.test.js — the data entry role on the website, and the six-digit code sign-in
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn, preOf } = require("../harness/web");
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
