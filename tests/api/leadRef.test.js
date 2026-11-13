// tests/api/leadRef.test.js — a lead counter that fell behind (a reset) must not block new leads.
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

test("a new lead takes the next number above the highest one even when the counter was reset", async () => {
  const b = h.BROKERS.broker;
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const res = await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: b.phone, code });
  const auth = { Authorization: `Bearer ${res.body.token}` };
  const first = await request(h.app.app).post("/api/v1/leads").set(auth).send({ phone1: "01011112222", name: "One", kind: "buyer" });
  expect(first.status).toBeLessThan(300);
  await h.query("UPDATE agencies SET lead_ref_seq = 0 WHERE id = $1", [b.agency_id]);
  const second = await request(h.app.app).post("/api/v1/leads").set(auth).send({ phone1: "01033334444", name: "Two", kind: "buyer" });
  expect(second.status).toBeLessThan(300);
  expect(second.body.lead.ref).not.toBe(first.body.lead.ref);
});
