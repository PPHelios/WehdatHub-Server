// tests/api/ownersApi.test.js — Capabilities, owner profiles, requests, activity log and team admin through /api/v1.
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
  await h.seedBroker("manager");
  await h.seedBroker("owner");
});
afterAll(() => closeHarness());

const api = () => request(h.app.app);
async function as(who) {
  const b = h.BROKERS[who];
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const t = (await api().post("/api/v1/auth/code/verify").send({ phone: b.phone, code })).body.token;
  return { Authorization: `Bearer ${t}` };
}

test("capabilities follow the role", async () => {
  const br = (await api().get("/api/v1/capabilities").set(await as("broker"))).body;
  const mg = (await api().get("/api/v1/capabilities").set(await as("manager"))).body;
  const ow = (await api().get("/api/v1/capabilities").set(await as("owner"))).body;
  expect(br.can.accessRequests).toBe(false);
  expect(mg.can.accessRequests).toBe(true);
  expect(mg.can.inviteManager).toBe(false);
  expect(ow.can.inviteManager).toBe(true);
  expect(ow.can.markPrivate).toBe(true);
});

test("managers see the request queue and activity log, brokers do not", async () => {
  expect((await api().get("/api/v1/access-requests").set(await as("broker"))).status).toBe(403);
  expect((await api().get("/api/v1/access-requests").set(await as("manager"))).status).toBe(200);
  expect((await api().get("/api/v1/activity-log").set(await as("broker"))).status).toBe(403);
  expect((await api().get("/api/v1/activity-log").set(await as("owner"))).status).toBe(200);
});

test("a manager cannot invite a manager or change roles; the owner can", async () => {
  const body = { name: "New Mgr", phone: "01000000777", role: "manager" };
  expect((await api().post("/api/v1/team/invite").set(await as("manager")).send(body)).status).toBe(403);
  // The test agency may have no free seat (402); what matters is that the owner is not refused for rank.
  expect((await api().post("/api/v1/team/invite").set(await as("owner")).send(body)).status).not.toBe(403);
  expect((await api().post(`/api/v1/team/${h.BROKERS.broker.id}/role`).set(await as("manager")).send({ role: "manager" })).status).toBe(403);
  expect((await api().post(`/api/v1/team/${h.BROKERS.broker.id}/role`).set(await as("owner")).send({ role: "manager" })).status).toBe(200);
});

test("owners list answers, and only the agency owner marks private", async () => {
  expect((await api().get("/api/v1/owners").set(await as("manager"))).status).toBe(200);
  const r = await api().post("/api/v1/portfolio/unit/10000000-0000-0000-0000-0000000000aa").set(await as("manager")).send({ value: true });
  expect(r.status).toBe(403);
});

test("dashboard and win-loss are for managers; prices and reports for everyone", async () => {
  expect((await api().get("/api/v1/dashboard").set(await as("broker"))).status).toBe(403);
  expect((await api().get("/api/v1/dashboard").set(await as("manager"))).status).toBe(200);
  expect((await api().get("/api/v1/insights/winloss").set(await as("broker"))).status).toBe(403);
  expect((await api().get("/api/v1/insights/prices").set(await as("broker"))).status).toBe(200);
  expect((await api().post("/api/v1/report").set(await as("broker")).send({ text: "ab" })).status).toBe(422);
});

test("deals, commissions and sources follow the role", async () => {
  const br = await as("broker");
  const mg = await as("manager");
  expect((await api().get("/api/v1/deals").set(br)).status).toBe(200);
  expect((await api().get("/api/v1/commissions").set(br)).status).toBe(200);
  expect((await api().get("/api/v1/sources").set(br)).status).toBe(403);
  expect((await api().get("/api/v1/sources").set(mg)).status).toBe(200);
  expect((await api().get("/api/v1/portal-enquiries").set(br)).status).toBe(403);
  expect((await api().get("/api/v1/portal-enquiries").set(mg)).status).toBe(200);
  expect((await api().get("/api/v1/links").set(br)).status).toBe(200);
  expect((await api().get("/api/v1/commissions/00000000-0000-0000-0000-000000000000").set(br)).status).toBe(403);
});

test("catalogue, plan and platform follow the role", async () => {
  const br = await as("broker");
  const ow = await as("owner");
  expect((await api().get("/api/v1/catalogue").set(br)).status).toBe(200);
  expect((await api().get("/api/v1/plan").set(br)).status).toBe(403); // the plan and its payments are for managers and the agency owner
  expect((await api().get("/api/v1/plan").set(ow)).status).toBe(200);
  expect((await api().get("/api/v1/usage").set(br)).status).toBe(200);
  expect((await api().get("/api/v1/library").set(br)).status).toBe(403);
  expect((await api().post("/api/v1/plan/pay").set(br).send({})).status).toBe(403);
  expect((await api().get("/api/v1/platform").set(ow)).status).toBe(404);
  expect((await api().post("/api/v1/platform/signup").set(br).send({ open: true })).status).toBe(404);
});
