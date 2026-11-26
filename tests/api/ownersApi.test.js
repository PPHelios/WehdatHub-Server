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
  const scope = "?strictScope=1&broker=";
  const allowed = await api().get("/api/v1/dashboard" + scope + h.BROKERS.broker.id).set(await as("manager"));
  expect(allowed.status).toBe(200);
  expect(allowed.body.brokerId).toBe(h.BROKERS.broker.id);
  expect(allowed.body.weeklyRanges).toHaveLength(8);
  expect(allowed.body.weeklyRanges[0]).toEqual(expect.objectContaining({ from: expect.any(String), to: expect.any(String), label: expect.any(String) }));
  expect(allowed.body.unassignedScope).toBe("agency");
  expect((await api().get("/api/v1/dashboard" + scope + h.BROKERS.rival.id).set(await as("manager"))).status).toBe(422);
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

test("Search returns agency credit balance only to owners and managers", async () => {
  await h.query("UPDATE agencies SET ai_usage_mode = 'per_user', ai_user_default_credits = 25 WHERE id = $1", [h.AGENCY_A]);
  const balance = (who) => as(who).then((headers) => api().get("/api/v1/search/credits").set(headers));
  const broker = await balance("broker");
  expect(broker.status).toBe(200);
  expect(broker.body).toEqual({ personal: { used: 0, limit: 25, remaining: 25 } });
  const manager = await balance("manager");
  expect(manager.body.personal).toEqual(broker.body.personal);
  expect(manager.body.agency).toEqual(expect.objectContaining({ remaining: expect.any(Number) }));
  const owner = await balance("owner");
  expect(owner.body.agency).toEqual(manager.body.agency);
  await h.query("UPDATE agencies SET ai_usage_mode = 'pool' WHERE id = $1", [h.AGENCY_A]);
  expect((await balance("broker")).body).toEqual({ personal: { used: 0, limit: null, remaining: null } });
});

test("Phase 5 commissions return claimable vs overdue split & byDeveloper, and sources return adBurn", async () => {
  const mg = await as("manager");
  const br = await as("broker");
  const devComm = await api().get("/api/v1/commissions?kind=developers").set(mg);
  expect(devComm.status).toBe(200);
  expect(devComm.body.totals).toHaveProperty("claimable");
  expect(devComm.body.totals).toHaveProperty("overdueAmount");
  expect(Array.isArray(devComm.body.byDeveloper)).toBe(true);
  const brComm = await api().get("/api/v1/commissions?kind=developers").set(br);
  expect(brComm.status).toBe(200);
  expect(brComm.body.byDeveloper).toEqual([]);
  expect(brComm.body.period).toBe("all");

  // Prior-month overdue developer commission still appears in default developer commissions + drill-through filters
  const Catalogue = require("../../services/catalogue");
  const CommissionsSvc = require("../../services/commissions");
  const LeadsSvc = require("../../services/leads");
  const DealsSvc = require("../../services/deals");
  const adminRow = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.manager.id]))[0];
  const brokerRow = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.broker.id]))[0];
  const devObj = (await Catalogue.saveDeveloper(h.pool, adminRow, { name: "Sodic" })).developer;
  const projObj = (await Catalogue.saveProject(h.pool, adminRow, { name: "Villette", developer_id: devObj.id })).project;
  await CommissionsSvc.saveTerms(h.pool, adminRow, projObj.id, { mode: "pct", pct: "3", payment_days: "30" });
  await h.insertListing({ broker_id: null, market: "primary", details: { catalogue: true }, project_id: projObj.id, code: "VL-1", price_value: 5000000 });
  const leadOld = (await LeadsSvc.captureLead(h.pool, brokerRow, { phones: "01099988871", name: "Old Client" })).lead;
  const dealOld = (await DealsSvc.createDeal(h.pool, adminRow, { leadKey: leadOld.ref, unitCode: "VL-1", mode: "pct", pct: 2, closingBrokerId: brokerRow.id, status: "signed" })).deal;
  const oldClosed = new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString();
  const pastDue = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  await h.query("UPDATE deals SET closed_at = $2 WHERE id = $1", [dealOld.id, oldClosed]);
  await h.query("UPDATE commissions SET status = 'claimed', due_on = $2 WHERE deal_id = $1", [dealOld.id, pastDue]);

  const overdueList = await api().get(`/api/v1/commissions?kind=developers&developer=${devObj.id}&overdue=1`).set(mg);
  expect(overdueList.status).toBe(200);
  expect(overdueList.body.items.length).toBe(1);
  expect(overdueList.body.totals.overdueAmount).toBe(150000);
  expect(overdueList.body.byDeveloper.find((d) => d.developerId === devObj.id)?.overdueCount).toBe(1);

  const month = new Date().toISOString().slice(0, 7);
  await h.query("INSERT INTO ad_spend (agency_id, month, source, amount_egp) VALUES ($1, $2, 'TikTok', 5000) ON CONFLICT DO NOTHING", [h.AGENCY_A, `${month}-01`]);
  const srcRes = await api().get("/api/v1/sources").set(mg);
  expect(srcRes.status).toBe(200);
  expect(srcRes.body.rows.find((r) => r.source === "TikTok")?.adBurn).toBe(true);
});
