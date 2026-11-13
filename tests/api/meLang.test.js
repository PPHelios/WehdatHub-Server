// tests/api/meLang.test.js — the app's language button changes the same preference as the website switch.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(() => closeHarness());

test("POST /me/lang saves the language and refuses anything else", async () => {
  const b = h.BROKERS.broker;
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const res = await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: b.phone, code });
  const auth = { Authorization: `Bearer ${res.body.token}` };
  expect((await request(h.app.app).post("/api/v1/me/lang").set(auth).send({ lang: "fr" })).status).toBe(422);
  expect((await request(h.app.app).post("/api/v1/me/lang").set(auth).send({ lang: "en" })).status).toBe(200);
  const row = await h.query("SELECT preferred_lang FROM brokers WHERE id = $1", [b.id]);
  expect(row.rows[0].preferred_lang).toBe("en");
});
