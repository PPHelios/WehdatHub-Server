// tests/api/assistantQuery.test.js — POST /api/v1/assistant/query deterministic-first routing, isolation & accountability cards.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");
const Leads = require("../../services/leads");
const AI = require("../../lib/ai");
const PlanGuard = require("../../lib/planGuard");
const Workspace = require("../../lib/workspace");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  AI.reset();
  PlanGuard.forget(h.AGENCY_A);
  Workspace.forgetAll();
});
afterAll(() => closeHarness());

const api = () => request(h.app.app);
async function auth(who) {
  const b = h.BROKERS[who];
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const t = (await api().post("/api/v1/auth/code/verify").send({ phone: b.phone, code })).body.token;
  return { Authorization: `Bearer ${t}` };
}

test("deterministic CRM queries spend 0 AI credits and return Option B cards + actions", async () => {
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const brokerRow = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.broker.id]))[0];
  const lead = (await Leads.captureLead(h.pool, brokerRow, { phones: "01088881111", name: "Stuck Client" })).lead;
  await h.query("UPDATE leads SET created_at = $2 WHERE id = $1", [lead.id, twoHoursAgo]);

  // If AI is called here, fail test loudly.
  AI.ask = () => { throw new Error("AI must not run for deterministic CRM query"); };

  const hdr = await auth("admin");
  const waiting = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "waiting over 1h", mode: "auto" });
  expect(waiting.status).toBe(200);
  expect(waiting.body).toMatchObject({ intent: "crm_leads", aiUsed: false });
  const stuckCard = waiting.body.cards.find((c) => c.kind === "stuck_leads");
  expect(stuckCard.items[0]).toMatchObject({ ref: expect.stringMatching(/^L-\d+$/) });
  expect(stuckCard.recommendedBrokers.map((b) => b.id)).toContain(h.BROKERS.colleague.id);
  expect(stuckCard.recommendedBrokers.map((b) => b.id)).not.toContain(h.BROKERS.broker.id);

  const disc = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "who is not updating leads?", mode: "auto" });
  expect(disc.status).toBe(200);
  expect(disc.body).toMatchObject({ intent: "crm_discipline", aiUsed: false });
  expect(disc.body.cards.some((c) => c.kind === "broker_discipline")).toBe(true);
});

test("resale mode locks strictly to resale and never mixes primary", async () => {
  await h.insertListing({ code: "RSL-1", compound: "Hyde Park", property_type: "apartment", market: "resale", price_value: 7000000 });
  await h.insertListing({ code: "PRM-1", compound: "Hyde Park", property_type: "apartment", market: "primary", price_value: 7000000 });

  const hdr = await auth("broker");
  const res = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "apartment in Hyde Park", mode: "resale" });
  expect(res.status).toBe(200);
  expect(res.body.intent).toBe("unit_search");
  expect(res.body.units.items.map((u) => u.code)).toEqual(["RSL-1"]);

  // Broker asking executive reports gets scoped/denied cleanly, never leaking agency totals.
  const denied = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "developer commissions", mode: "reports" });
  expect(denied.status).toBe(200);
  expect(denied.body.intent).toBe("clarify");
});

test("reports return canonical cards, team_lead scopes recommendedBrokers, and ViewGuard stays read-only", async () => {
  const mgrHdr = await auth("admin");
  const comm = await api().post("/api/v1/assistant/query").set(mgrHdr).send({ q: "developer commissions", mode: "reports" });
  expect(comm.status).toBe(200);
  expect(comm.body.intent).toBe("crm_commissions");
  expect(comm.body.cards[0]).toMatchObject({ kind: "metric_row", items: expect.any(Array) });
  expect(comm.body.cards[0].items[0]).toHaveProperty("unit", "EGP");

  const brief = await api().post("/api/v1/assistant/query").set(mgrHdr).send({ q: "agency brief", mode: "reports" });
  expect(brief.status).toBe(200);
  expect(brief.body.intent).toBe("crm_brief");
  expect(brief.body.cards[0]).toMatchObject({ kind: "metric_row", items: expect.any(Array) });

  // Team lead only receives own-team recommendedBrokers on stuck_leads.
  await h.query(
    `INSERT INTO brokers (id, agency_id, phone_number, name, role, is_active, preferred_lang, notify_prefs)
     VALUES ($1, $2, $3, 'Lead TL', 'team_lead', true, 'en', '{"quiet":{"enabled":false}}')`,
    [h.BROKERS.manager.id, h.BROKERS.manager.agency_id, h.BROKERS.manager.phone]
  );
  await h.query("UPDATE brokers SET team_lead_id = $2 WHERE id = $1", [h.BROKERS.colleague.id, h.BROKERS.manager.id]);
  const brokerRow = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.colleague.id]))[0];
  const lead = (await Leads.captureLead(h.pool, brokerRow, { phones: "01077776666", name: "Team Lead Queue" })).lead;
  await h.query("UPDATE leads SET created_at = $2 WHERE id = $1", [lead.id, new Date(Date.now() - 2 * 3600 * 1000).toISOString()]);
  const tlHdr = await auth("manager");
  const tlRes = await api().post("/api/v1/assistant/query").set(tlHdr).send({ q: "waiting over 1h", mode: "reports" });
  expect(tlRes.status).toBe(200);
  const tlCard = tlRes.body.cards.find((c) => c.kind === "stuck_leads");
  const recIds = tlCard.recommendedBrokers.map((b) => b.id);
  expect(recIds).not.toContain(h.BROKERS.broker.id);

  // NCH ViewGuard read-only simulation: both unsure unit_search and primary succeed with 0 writes.
  const ViewGuard = require("../../lib/viewGuard");
  const AssistantQuery = require("../../services/assistantQuery");
  const adminActor = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];
  const roSearch = await ViewGuard.runReadOnly(() => AssistantQuery.query(h.pool, { AI, actor: adminActor, text: "apartment xyzfoo", mode: "resale" }));
  expect(roSearch.intent).toBe("unit_search");
  expect(roSearch.suggestPrimary).toBe(true);
  const roPrimary = await ViewGuard.runReadOnly(() => AssistantQuery.query(h.pool, { AI, actor: adminActor, text: "Mivida payment plan", mode: "primary" }));
  expect(roPrimary.intent).toBe("primary");
  expect(roPrimary.cards[0]).toMatchObject({ kind: "text_answer", answer: expect.any(String) });
});

test("owner Q&A answers windowed broker/team/agency activity, today viewings, facebook leads, and avg/per-person response time at 0 AI credits", async () => {
  AI.ask = () => { throw new Error("AI must not run for deterministic owner Q&A"); };
  const adminHdr = await auth("admin");
  const brokerRow = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.broker.id]))[0];
  const collRow = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.colleague.id]))[0];

  // Lead from Facebook contacted by Broker One in 20 min, plus viewing booked today and TL team setup.
  const fbLead = (await Leads.captureLead(h.pool, brokerRow, { phones: "01066661111", name: "FB Lead", source: "Facebook" })).lead;
  const createdAt = new Date(Date.now() - 2 * 3600 * 1000);
  await h.query("UPDATE leads SET created_at = $2 WHERE id = $1", [fbLead.id, createdAt.toISOString()]);
  await Leads.markContacted(h.pool, brokerRow, fbLead.id);
  const Stages = require("../../domain/leadStages");
  const todayEnd = Stages.cairoDayAt(new Date(), 1, 0).getTime();
  const viewAt = new Date(Math.min(Date.now() + 2 * 3600 * 1000, todayEnd - 60 * 1000));
  await Leads.setFollowUp(h.pool, brokerRow, fbLead.id, { at: viewAt, kind: "viewing" });

  await h.query(
    `INSERT INTO brokers (id, agency_id, phone_number, name, role, is_active, preferred_lang, notify_prefs)
     VALUES ($1, $2, $3, 'Omar', 'team_lead', true, 'en', '{"quiet":{"enabled":false}}')`,
    [h.BROKERS.manager.id, h.BROKERS.manager.agency_id, h.BROKERS.manager.phone]
  );
  await h.query("UPDATE brokers SET team_lead_id = $2 WHERE id = $1", [collRow.id, h.BROKERS.manager.id]);

  // 1) "what did Broker One do today?" -> windowed crm_broker with calls, viewings, updates metrics
  const bAct = await api().post("/api/v1/assistant/query").set(adminHdr).send({ q: "what did Broker One do today?", mode: "auto" });
  expect(bAct.status).toBe(200);
  expect(bAct.body).toMatchObject({ intent: "crm_broker", aiUsed: false });
  expect(bAct.body.cards.some((c) => c.kind === "broker_scorecard")).toBe(true);

  // 2) "how did Omar's team do this week?" -> crm_team
  const tAct = await api().post("/api/v1/assistant/query").set(adminHdr).send({ q: "how did Omar's team do this week?", mode: "auto" });
  expect(tAct.status).toBe(200);
  expect(tAct.body).toMatchObject({ intent: "crm_team", aiUsed: false });

  // 3) "what did the agency do today?" -> windowed crm_brief
  const aAct = await api().post("/api/v1/assistant/query").set(adminHdr).send({ q: "what did the agency do today?", mode: "auto" });
  expect(aAct.status).toBe(200);
  expect(aAct.body).toMatchObject({ intent: "crm_brief", aiUsed: false });

  // 4) "how many viewings we have today?" -> crm_viewings
  const vw = await api().post("/api/v1/assistant/query").set(adminHdr).send({ q: "how many viewings we have today?", mode: "auto" });
  expect(vw.status).toBe(200);
  expect(vw.body).toMatchObject({ intent: "crm_viewings", aiUsed: false });
  expect(vw.body.cards[0].items[0].value).toBeGreaterThanOrEqual(1);

  // 5) "how many leads came from facebook?" -> crm_sources highlighting Facebook
  const fb = await api().post("/api/v1/assistant/query").set(adminHdr).send({ q: "how many leads came from facebook?", mode: "auto" });
  expect(fb.status).toBe(200);
  expect(fb.body).toMatchObject({ intent: "crm_sources", aiUsed: false });
  expect(fb.body.headline).toMatch(/Facebook/i);

  // 6) "what is the average response time per person?" -> crm_response_time with exact overall median (not mean of medians)
  const adminBroker = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];
  const fastAt = new Date(Date.now() - 40 * 60000);
  for (let i = 0; i < 4; i++) {
    const fl = (await Leads.captureLead(h.pool, adminBroker, { phones: `0106666000${i}`, name: `Fast ${i}` })).lead;
    await h.query("UPDATE leads SET assigned_broker_id = $2, created_at = $3, last_contact_at = $4 WHERE id = $1", [
      fl.id, h.BROKERS.colleague.id, fastAt.toISOString(), new Date(fastAt.getTime() + 5 * 60000).toISOString()
    ]);
  }
  const rt = await api().post("/api/v1/assistant/query").set(adminHdr).send({ q: "what is the average response time per person?", mode: "auto" });
  expect(rt.status).toBe(200);
  expect(rt.body).toMatchObject({ intent: "crm_response_time", aiUsed: false });
  expect(rt.body.cards.some((c) => c.kind === "bar_breakdown")).toBe(true);
  // 4 leads at 5m vs 1 lead at 15m -> true overall median is 5, not unweighted average of per-broker medians (10).
  expect(rt.body.cards[0].items.find((x) => /Median/i.test(x.label))?.value).toBe(5);
});

test("testRole NCH read-only view allows POST /api/v1/assistant/query", () => {
  const TestRole = require("../../lib/testRole");
  expect(TestRole.viewPostAllowed("POST", "/assistant/query")).toBe(true);
});

test("resale assistant unit_search returns >20 continuation token f, marketLock, and status counts without primary leak", async () => {
  for (let i = 1; i <= 23; i++) {
    await h.insertListing({
      code: `RES-${i}`,
      market: "resale",
      compound: "Hyde Park",
      listing_type: "sale",
      property_type: "apartment",
      price_value: 4000000 + i * 10000
    });
  }
  for (let i = 1; i <= 2; i++) {
    await h.insertListing({
      code: `PRM-${i}`,
      market: "primary",
      inventory_type: "primary_unit",
      compound: "Hyde Park",
      listing_type: "sale",
      property_type: "apartment",
      price_value: 4100000
    });
  }

  const hdr = await auth("broker");
  const res = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "شقة ريسيل في هايد بارك", mode: "auto" });
  expect(res.status).toBe(200);
  expect(res.body.intent).toBe("unit_search");
  expect(res.body.units.marketLock).toBe("resale");
  expect(res.body.units.total).toBe(23);
  expect(res.body.units.items).toHaveLength(20);
  expect(res.body.units.counts).toMatchObject({ active: 23, sold: 0, archived: 0 });
  expect(typeof res.body.units.f).toBe("string");
  expect(res.body.units.items.every((u) => u.code.startsWith("RES-"))).toBe(true);
});

test("Solo owner scopes personal reports cleanly (my stats, today activity) and declines team-only reports with My Stats / Plan link", async () => {
  await h.seedBroker("owner");
  await h.query("UPDATE brokers SET preferred_lang = 'en' WHERE id = $1", [h.BROKERS.owner.id]);
  await h.query("UPDATE brokers SET is_active = false WHERE agency_id = $1 AND id <> $2", [h.AGENCY_A, h.BROKERS.owner.id]);
  await h.query("UPDATE agencies SET pilot = false, plan = 'solo', paid_until = now() + interval '30 days' WHERE id = $1", [h.AGENCY_A]);
  PlanGuard.forget(h.AGENCY_A);
  Workspace.forgetAll();

  const ownerRow = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.owner.id]))[0];
  const lead = (await Leads.captureLead(h.pool, ownerRow, { name: "Solo Lead", phones: "01055551234", source: "Facebook" })).lead;
  await h.query("UPDATE leads SET assigned_broker_id = $1, created_at = now() - interval '2 hours', last_contact_at = NULL WHERE id = $2", [h.BROKERS.owner.id, lead.id]);

  const hdr = await auth("owner");
  const stats = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "my stats", mode: "auto" });
  expect(stats.status).toBe(200);
  expect(stats.body.intent).toBe("crm_brief");
  expect(stats.body.headline).toMatch(/My stats|Your stats/i);

  const act = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "today activity", mode: "reports" });
  expect(act.status).toBe(200);
  expect(act.body.intent).toBe("crm_brief");
  expect(act.body.headline).toMatch(/Your activity/i);

  const teamQ = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "who is not updating leads?", mode: "reports" });
  expect(teamQ.status).toBe(200);
  expect(teamQ.body.intent).toBe("clarify");
  expect(teamQ.body.links.some((l) => l.screen === "Dashboard" || l.screen === "Plan")).toBe(true);

  const queueQ = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "waiting over 1h", mode: "auto" });
  expect(queueQ.status).toBe(200);
  expect(queueQ.body.intent).toBe("crm_leads");
  expect(queueQ.body.cards[0].canAssign).toBe(false);
  expect(queueQ.body.cards[0].canNudge).toBe(false);
});
