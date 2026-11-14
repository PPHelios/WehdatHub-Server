// tests/api/clientRequests.test.js — The client requests page: add (standalone or linked by code or phone), Pending and Fulfilled tabs, fulfil, delete.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");
const Leads = require("../../services/leads");
const Card = require("../../domain/leadCard");

jest.setTimeout(90000);

let h;
let tok;
beforeAll(async () => {
  h = await createHarness();
  const b = h.BROKERS.broker;
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  tok = (await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: b.phone, code })).body.token;
});
afterAll(() => closeHarness());

const get = (p) => request(h.app.app).get(`/api/v1${p}`).set("Authorization", `Bearer ${tok}`);
const post = (p) => request(h.app.app).post(`/api/v1${p}`).set("Authorization", `Bearer ${tok}`);

test("add standalone and linked (by code and by phone), tabs, fulfil, delete", async () => {
  const broker = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.broker.id]))[0];
  const lead = (await Leads.captureLead(h.pool, broker, { phones: ["01077778888"], name: "Req Client" })).lead;
  const ref = Card.refLabel(lead.ref);

  expect((await post("/client-requests").send({ q: "" })).status).toBe(422);
  const solo = await post("/client-requests").send({ q: "شقة 3 غرف في التجمع لحد 5 مليون" });
  expect(solo.status).toBe(200);
  expect(solo.body.lead).toBeNull();
  const byCode = await post("/client-requests").send({ q: "villa in sheikh zayed", lead: ref });
  expect(byCode.status).toBe(200);
  expect(byCode.body.lead.ref).toBe(ref);
  const byPhone = await post("/client-requests").send({ q: "شقة في الشيخ زايد", lead: "01077778888" });
  expect(byPhone.status).toBe(200);
  expect((await post("/client-requests").send({ q: "شقة في التجمع", lead: "L-9999" })).body.error).toBe("lead_not_found");

  const pending = await get("/client-requests?tab=pending");
  expect([pending.status, pending.body.error]).toEqual([200, undefined]);
  expect(pending.body.pending).toBe(3);
  expect(pending.body.items.filter((i) => i.lead && i.lead.ref === ref)).toHaveLength(2);

  expect((await post(`/client-requests/${solo.body.id}/fulfil`)).body.ok).toBe(true);
  const done = await get("/client-requests?tab=fulfilled");
  expect(done.body.items.map((i) => i.id)).toEqual([solo.body.id]);
  expect((await get("/client-requests")).body.pending).toBe(2);
  expect((await h.query("SELECT alerts_enabled FROM saved_searches WHERE id = $1", [solo.body.id]))[0].alerts_enabled).toBe(false);

  expect((await post(`/client-requests/${byCode.body.id}/delete`)).body.ok).toBe(true);
  expect((await post(`/client-requests/${byCode.body.id}/delete`)).status).toBe(404);
  expect((await get("/client-requests")).body.pending).toBe(1);
});

test("the web page: add, pending and fulfilled tabs, mark fulfilled, delete", async () => {
  const { signIn } = require("../harness/web");
  const { agent, csrf } = await signIn(h, "broker");
  const add = await agent.post("/app/requests").type("form").send({ _csrf: csrf, q: "شقة في الشيخ زايد لحد 6 مليون" });
  expect(add.status).toBe(303);
  const bad = await agent.post("/app/requests").type("form").send({ _csrf: csrf, q: "شقة في التجمع", lead: "L-9999" });
  expect(bad.headers.location).toContain("error=lead_not_found");
  const page = await agent.get("/app/requests");
  expect(page.status).toBe(200);
  expect(page.text).toContain("data-request=");
  const id = (page.text.match(/data-request="([0-9a-f-]{36})"/) || [])[1];
  expect((await agent.post(`/app/requests/${id}/fulfil`).type("form").send({ _csrf: csrf })).status).toBe(303);
  expect((await agent.get("/app/requests?tab=fulfilled")).text).toContain(`data-request="${id}"`);
  expect((await agent.post(`/app/requests/${id}/delete`).type("form").send({ _csrf: csrf })).status).toBe(303);
  expect((await agent.get("/app/requests?tab=fulfilled")).text).not.toContain(`data-request="${id}"`);
});
