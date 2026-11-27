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

test("Wave 2 assistant executes crm_deals with closer/participant labels, inventory_count, overdue commissions drill-through, clarifies market/mode, and reports appliedFilters", async () => {
  await h.query("UPDATE brokers SET name = 'Sara', preferred_lang = 'en' WHERE id = $1", [h.BROKERS.broker.id]);
  await h.insertListing({ code: "INV-1", market: "resale", compound: "Hyde Park", property_type: "apartment", listing_type: "sale", price_value: 3500000 });
  await h.insertListing({ code: "INV-2", market: "resale", compound: "Hyde Park", property_type: "apartment", listing_type: "sale", price_value: 3800000 });
  const lead = (await Leads.captureLead(h.pool, h.BROKERS.broker, { phones: "01099990001", name: "Buyer D" })).lead;
  const Deals = require("../../services/deals");
  const admin = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];
  await Deals.createDeal(h.pool, admin, { leadKey: lead.ref, unitCode: "INV-1", price: 3500000, mode: "amount", amount: 70000, closingBrokerId: h.BROKERS.broker.id, status: "signed" });

  const hdr = await auth("admin");

  const dealsRes = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "resale deals closed by Sara this month", mode: "auto" });
  expect(dealsRes.status).toBe(200);
  expect(dealsRes.body.intent).toBe("crm_deals");
  expect(dealsRes.body.headline).toMatch(/Closed by Sara/i);
  expect(dealsRes.body.understood.appliedFilters.length).toBeGreaterThan(0);
  expect(dealsRes.body.links[0]).toMatchObject({ screen: "Deals", params: expect.objectContaining({ market: "resale", brokerRole: "closer" }) });

  const countRes = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "how many apartments do we have in Hyde Park?", mode: "auto" });
  expect(countRes.status).toBe(200);
  expect(countRes.body.intent).toBe("inventory_count");
  expect(countRes.body.headline).toMatch(/1/);

  const commRes = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "overdue developer commissions", mode: "auto" });
  expect(commRes.status).toBe(200);
  expect(commRes.body.intent).toBe("crm_commissions");
  expect(commRes.body.links[0]).toMatchObject({ screen: "Commissions", params: { kind: "developers", overdue: true } });

  const clarFin = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "شقق في زايد بمقدم مليون", mode: "auto" });
  expect(clarFin.status).toBe(200);
  expect(clarFin.body.intent).toBe("clarify");
  expect(clarFin.body.actions.some((a) => a.kind === "pivot_mode" && a.mode === "resale")).toBe(true);
  expect(clarFin.body.actions.some((a) => a.kind === "pivot_mode" && a.mode === "primary")).toBe(true);
});

test("Wave 3 Task 1: stateful previousContext follow-ups (broker filter & budget bump) vs contextless clarify", async () => {
  await h.query("UPDATE brokers SET name = 'Sara', preferred_lang = 'en' WHERE id = $1", [h.BROKERS.broker.id]);
  await h.insertListing({ code: "BUMP-47", market: "resale", compound: "Hyde Park", property_type: "apartment", listing_type: "sale", price_value: 4_700_000 });
  const lead = (await Leads.captureLead(h.pool, h.BROKERS.broker, { phones: "01055551111", name: "Ctx Lead" })).lead;
  const Deals = require("../../services/deals");
  const admin = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];
  await Deals.createDeal(h.pool, admin, { leadKey: lead.ref, unitCode: "BUMP-47", price: 4_700_000, mode: "amount", amount: 94000, closingBrokerId: h.BROKERS.broker.id, status: "signed" });
  await h.insertListing({ code: "BUMP-47B", market: "resale", compound: "Hyde Park", property_type: "apartment", listing_type: "sale", price_value: 4_700_000 });

  const hdr = await auth("admin");

  // Contextless fragment must return clarify, not guess
  const bare = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "بس بتوع سارة", mode: "auto" });
  expect(bare.status).toBe(200);
  expect(bare.body.intent).toBe("clarify");

  // Deals query -> nextContext -> follow-up "بس بتوع سارة" narrows to Sara
  const deals = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "resale deals this month", mode: "auto" });
  expect(deals.body.nextContext).toMatchObject({ job: "deals_report", market: "resale" });
  const followBroker = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "بس بتوع سارة", mode: "auto", previousContext: deals.body.nextContext });
  expect(followBroker.body.intent).toBe("crm_deals");
  expect(followBroker.body.headline).toMatch(/Sara/i);

  // Unit search under 4M misses 4.7M unit -> bump budget 1m finds it
  const search1 = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "resale apartment in Hyde Park under 4m", mode: "resale" });
  expect(search1.body.nextContext).toMatchObject({ job: "find_units", maxPrice: 4000000 });
  expect(search1.body.units.total).toBe(0);
  const bump = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "لو زودنا الميزانية مليون", mode: "resale", previousContext: search1.body.nextContext });
  expect(bump.body.intent).toBe("unit_search");
  expect(bump.body.units.total).toBe(1);
  expect(bump.body.units.items[0].code).toBe("BUMP-47B");
});

test("Wave 3 Task 2: two matching brokers return disambiguate card without guessing", async () => {
  await h.query("UPDATE brokers SET name = 'Sara Ahmed', preferred_lang = 'en' WHERE id = $1", [h.BROKERS.broker.id]);
  await h.query("UPDATE brokers SET name = 'Sara Hassan', preferred_lang = 'en' WHERE id = $1", [h.BROKERS.colleague.id]);
  const hdr = await auth("admin");

  const dealsRes = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "deals closed by Sara this month", mode: "reports" });
  expect(dealsRes.status).toBe(200);
  expect(dealsRes.body.intent).toBe("disambiguate");
  expect(dealsRes.body.cards[0]).toMatchObject({
    kind: "disambiguate",
    options: expect.arrayContaining([
      expect.objectContaining({ id: h.BROKERS.broker.id, label: "Sara Ahmed", query: expect.stringMatching(/Sara Ahmed/i) }),
      expect.objectContaining({ id: h.BROKERS.colleague.id, label: "Sara Hassan", query: expect.stringMatching(/Sara Hassan/i) })
    ])
  });

  const actRes = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "what did Sara do today", mode: "reports" });
  expect(actRes.status).toBe(200);
  expect(actRes.body.intent).toBe("disambiguate");
});

test("Wave 3 Task 4: opened links without follow-up, strict approaching SLA vs disabled fallback, and brokers ranked by noNextStep", async () => {
  await h.query("UPDATE brokers SET name = 'Sara', preferred_lang = 'en' WHERE id = $1", [h.BROKERS.broker.id]);
  await h.query("UPDATE brokers SET name = 'Omar', preferred_lang = 'en' WHERE id = $1", [h.BROKERS.colleague.id]);
  await h.insertListing({ code: "OP-1", market: "resale", price_value: 2000000 });
  const unitRow = (await h.query("SELECT id FROM listings WHERE agency_id = $1 AND code = 'OP-1'", [h.AGENCY_A]))[0];

  const openedLead = (await Leads.captureLead(h.pool, h.BROKERS.broker, { phones: "01066661111", name: "Opened No FU" })).lead;
  const scheduledLead = (await Leads.captureLead(h.pool, h.BROKERS.broker, { phones: "01066662222", name: "Opened Has FU" })).lead;
  const slaDueLead = (await Leads.captureLead(h.pool, h.BROKERS.broker, { phones: "01066663333", name: "Near SLA" })).lead;
  const offHoursLead = (await Leads.captureLead(h.pool, h.BROKERS.colleague, { phones: "01066664444", name: "Off Hours" })).lead;

  const ol = await Leads.getLead(h.pool, h.BROKERS.broker, openedLead.ref);
  const sl = await Leads.getLead(h.pool, h.BROKERS.broker, scheduledLead.ref);
  await h.query("UPDATE leads SET follow_up_status = 'open', follow_up_kind = 'call', next_follow_up_at = now() + interval '1 hour' WHERE id = $1", [sl.id]);

  // Seed repeated opens on openedLead -> grouped into 1 row; scheduledLead excluded
  await h.query(
    `INSERT INTO share_links (token_hash, agency_id, listing_id, broker_id, lead_id, channel, source, expires_at, open_count, last_opened_at)
     VALUES ('tok-1', $1, $2, $3, $4, 'whatsapp', 'lead', now() + interval '7 days', 3, now() - interval '10 minutes'),
            ('tok-2', $1, $2, $3, $4, 'whatsapp', 'lead', now() + interval '7 days', 2, now() - interval '2 minutes'),
            ('tok-3', $1, $2, $3, $5, 'whatsapp', 'lead', now() + interval '7 days', 1, now() - interval '1 minute')`,
    [h.AGENCY_A, unitRow.id, h.BROKERS.broker.id, ol.id, sl.id]
  );

  const Card = require("../../domain/leadCard");
  // SLA enabled: only slaDueLead (response_due_at within 30m) shows, NEVER offHoursLead (response_due_at NULL even if older than 40m)
  await h.query(`UPDATE agencies SET lead_rules = '{"enabled":true,"waitMinutes":30}'::jsonb WHERE id = $1`, [h.AGENCY_A]);
  await h.query("UPDATE leads SET response_due_at = now() + interval '10 minutes', last_contact_at = NULL WHERE id = $1", [slaDueLead.id]);
  await h.query("UPDATE leads SET created_at = now() - interval '50 minutes', response_due_at = NULL, last_contact_at = NULL WHERE id = $1", [offHoursLead.id]);

  // Seed noNextStep open lead (contacted stage without open follow-up) for Sara
  await h.query("UPDATE leads SET stage = 'contacted', follow_up_status = NULL WHERE id = $1", [openedLead.id]);

  const hdr = await auth("admin");

  const openedRes = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "offer links opened without follow-up", mode: "reports" });
  expect(openedRes.status).toBe(200);
  expect(openedRes.body.intent).toBe("crm_opened_no_followup");
  expect(openedRes.body.headline).toMatch(/Offer link opened/i);
  expect(openedRes.body.cards[0].items.map((x) => x.ref)).toEqual([Card.refLabel(openedLead.ref)]);

  const slaOnRes = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "leads approaching SLA", mode: "reports" });
  expect(slaOnRes.status).toBe(200);
  expect(slaOnRes.body.intent).toBe("crm_approaching_sla");
  expect(slaOnRes.body.cards[0].items.map((x) => x.ref)).toEqual([Card.refLabel(slaDueLead.ref)]);

  // Disable agency SLA -> explicit 40-59 min queue activates
  await h.query(`UPDATE agencies SET lead_rules = '{"enabled":false,"waitMinutes":30}'::jsonb WHERE id = $1`, [h.AGENCY_A]);
  const slaOffRes = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "leads approaching SLA", mode: "reports" });
  expect(slaOffRes.status).toBe(200);
  expect(slaOffRes.body.headline).toMatch(/40.*59 min/i);
  expect(slaOffRes.body.cards[0].items.map((x) => x.ref)).toEqual([Card.refLabel(offHoursLead.ref)]);

  const stuckRes = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "brokers ranked by no next step", mode: "reports" });
  expect(stuckRes.status).toBe(200);
  expect(stuckRes.body.intent).toBe("crm_stuck_brokers");
  expect(stuckRes.body.cards[0].rows[0].name).toBe("Sara");
});

test("Wave 3 Task 5: historical response activity vs waiting queue from yesterday", async () => {
  await h.query("UPDATE brokers SET name = 'Sara', preferred_lang = 'ar' WHERE id = $1", [h.BROKERS.broker.id]);
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  const Router = require("../../domain/assistantRouter");
  const yestWin = Router.extractTimeWindow("yesterday", new Date());
  const yestMid = new Date((yestWin.from.getTime() + yestWin.to.getTime()) / 2);

  // Lead created 2 days ago, Sara logged contacted event yesterday
  const repliedLead = (await Leads.captureLead(h.pool, h.BROKERS.broker, { phones: "01077778888", name: "Replied Yest" })).lead;
  await h.query("UPDATE leads SET created_at = $2, last_contact_at = $3 WHERE id = $1", [repliedLead.id, twoDaysAgo.toISOString(), yestMid.toISOString()]);
  await h.query("INSERT INTO lead_events (agency_id, lead_id, broker_id, kind, created_at) VALUES ($1, $2, $3, 'contacted', $4)", [h.AGENCY_A, repliedLead.id, h.BROKERS.broker.id, yestMid.toISOString()]);

  // Uncontacted lead waiting since yesterday
  const waitLead = (await Leads.captureLead(h.pool, h.BROKERS.broker, { phones: "01077779999", name: "Still Waiting" })).lead;
  await h.query("UPDATE leads SET created_at = $2, last_contact_at = NULL WHERE id = $1", [waitLead.id, yestMid.toISOString()]);

  const hdr = await auth("admin");
  const repliedRes = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "مين رد على العملاء امبارح؟", mode: "auto" });
  expect(repliedRes.status).toBe(200);
  expect(repliedRes.body.intent).toBe("crm_response_time");
  expect(repliedRes.body.cards.some((c) => c.kind === "bar_breakdown" && c.rows.some((r) => r.label === "Sara"))).toBe(true);

  const waitRes = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "مين مستني رد من امبارح؟", mode: "auto" });
  expect(waitRes.status).toBe(200);
  expect(waitRes.body.intent).toBe("crm_leads");
  expect(waitRes.body.cards[0].items.some((x) => x.ref.includes("000"))).toBe(true);
});

test("review fixes: Arabic alef disambiguation replace, Solo stuck-brokers guard, non-manager deals no colleague leak, nextContext on broker/brief, budgetBump clarify", async () => {
  await h.query("UPDATE brokers SET name = 'أحمد علي', preferred_lang = 'ar' WHERE id = $1", [h.BROKERS.broker.id]);
  const [ahmad2] = (await h.pool.query(
    "INSERT INTO brokers (agency_id, name, phone_number, role, is_active) VALUES ($1, 'أحمد حسن', '+201099988877', 'broker', true) RETURNING id, name",
    [h.AGENCY_A]
  )).rows;
  expect(ahmad2.id).toBeTruthy();

  const admHdr = await auth("admin");
  const disRes = await api().post("/api/v1/assistant/query").set(admHdr).send({ q: "مكالمات أحمد امبارح", mode: "reports" });
  expect(disRes.status).toBe(200);
  expect(disRes.body.intent).toBe("disambiguate");
  const firstOpt = disRes.body.cards[0].options[0];
  expect(firstOpt.query).toMatch(/^مكالمات أحمد (?:علي|حسن) امبارح$/);

  // Brief & broker scorecards emit nextContext for contextual follow-ups
  const briefRes = await api().post("/api/v1/assistant/query").set(admHdr).send({ q: "agency brief today", mode: "reports" });
  expect(briefRes.status).toBe(200);
  expect(briefRes.body.nextContext).toMatchObject({ job: "brief" });

  // Non-manager matching own first name resolves to self without leaking colleague names in disambiguate
  const brHdr = await auth("broker");
  const ownDealRes = await api().post("/api/v1/assistant/query").set(brHdr).send({ q: "deals closed by أحمد", mode: "reports" });
  expect(ownDealRes.status).toBe(200);
  expect(ownDealRes.body.intent).toBe("crm_deals");

  // Open-budget search followed by budget bump clarifies instead of ignoring delta
  await h.query("UPDATE brokers SET preferred_lang = 'en' WHERE id = $1", [h.BROKERS.admin.id]);
  const openSearch = await api().post("/api/v1/assistant/query").set(admHdr).send({ q: "apartments in Tagamoa", mode: "resale" });
  expect(openSearch.status).toBe(200);
  const bumpNoMax = await api().post("/api/v1/assistant/query").set(admHdr).send({
    q: "increase budget by 1m",
    mode: "resale",
    previousContext: openSearch.body.nextContext
  });
  expect(bumpNoMax.status).toBe(200);
  expect(bumpNoMax.body.intent).toBe("clarify");
  expect(bumpNoMax.body.headline).toMatch(/maximum budget/i);

  // Solo owner asking team next-step rankings gets clarify rather than board
  await h.query("UPDATE agencies SET pilot = false, plan = 'solo', paid_until = now() + interval '30 days' WHERE id = $1", [h.AGENCY_A]);
  await h.query("UPDATE brokers SET is_active = false WHERE agency_id = $1 AND id <> $2", [h.AGENCY_A, h.BROKERS.admin.id]);
  PlanGuard.forget(h.AGENCY_A);
  Workspace.forgetAll();
  const soloStuck = await api().post("/api/v1/assistant/query").set(admHdr).send({ q: "brokers ranked by no next step", mode: "reports" });
  expect(soloStuck.status).toBe(200);
  expect(soloStuck.body.intent).toBe("clarify");
});

test("every answer carries 1-3 suggestion chips; unknown and off-topic questions never dead-end", async () => {
  const hdr = await auth("admin");
  for (const q of ["what is the weather today", "who knows", "leads waiting over 1h", "3 bedroom apartment in New Cairo", "how many apartments", "slowest response time"]) {
    const res = await api().post("/api/v1/assistant/query").set(hdr).send({ q, mode: "auto" });
    expect(res.status).toBe(200);
    expect(res.body.suggestions.length).toBeGreaterThanOrEqual(1);
    expect(res.body.suggestions.length).toBeLessThanOrEqual(3);
    for (const s of res.body.suggestions) expect(s).toMatchObject({ label: expect.any(String), q: expect.any(String) });
  }
  const off = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "tell me a joke", mode: "auto" });
  expect(off.body).toMatchObject({ intent: "clarify", understood: { job: "off_topic" } });
  const unit = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "3 bedroom apartment in New Cairo", mode: "auto" });
  expect(unit.body.units.statusCounts).toEqual(unit.body.units.counts);
});

test("chart cards: win/loss share and prices-in-area price_range, no AI", async () => {
  AI.ask = () => { throw new Error("AI must not run for chart answers"); };
  const hdr = await auth("admin");
  const ins = (code, price) => h.query(
    `INSERT INTO listings (agency_id, broker_id, code, status, listing_type, price_value, area_value, compound, details)
     VALUES ($1, $2, $3, 'active', 'sale', $4, 100, 'Chartville', '{}')`,
    [h.AGENCY_A, h.BROKERS.admin.id, code, price]
  );
  for (const [i, p] of [1e6, 2e6, 2e6, 3e6, 5e6].entries()) await ins(`CH${i}`, p);
  const res = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "prices in Chartville", mode: "auto" });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ intent: "crm_prices", aiUsed: false });
  const pr = res.body.cards.find((c) => c.kind === "price_range");
  expect(pr.bins.reduce((s, b) => s + b.count, 0)).toBe(5);
  expect(pr.summary).toMatch(/chartville/i);
  const wl = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "win rate", mode: "auto" });
  expect(wl.body.cards.filter((c) => ["share", "bar_breakdown", "metric_row"].includes(c.kind)).length).toBeGreaterThan(0);
});

test("chart gaps: compare from unitCodes, deltas, budget marker, broker avatar keys", async () => {
  AI.ask = () => { throw new Error("AI must not run"); };
  const hdr = await auth("admin");
  const ins = (code, price, area) => h.query(
    `INSERT INTO listings (agency_id, broker_id, code, status, listing_type, price_value, area_value, compound, details)
     VALUES ($1, $2, $3, 'active', 'sale', $4, $5, 'Gapville', '{}')`,
    [h.AGENCY_A, h.BROKERS.admin.id, code, price, area]
  );
  for (const [i, p] of [1e6, 2e6, 3e6, 4e6].entries()) await ins(`GP${i}`, p, 100 + i);
  const post = (body) => api().post("/api/v1/assistant/query").set(hdr).send({ mode: "auto", ...body });

  // search carries codes -> "compare" uses them
  const s = await post({ q: "Gapville", mode: "resale" });
  expect(s.body.nextContext.unitCodes.length).toBeGreaterThanOrEqual(2);
  const cmp = await post({ q: "compare", previousContext: s.body.nextContext });
  expect(cmp.body.intent).toBe("compare");
  expect(cmp.body.cards[0]).toMatchObject({ kind: "compare" });
  expect(cmp.body.cards[0].columns.length).toBeGreaterThanOrEqual(2);
  const two = await post({ q: "first two", previousContext: { job: "find_units", unitCodes: ["GP0", "GP1", "GP2"] } });
  expect(two.body.cards[0].columns.map((c) => c.code)).toEqual(["GP0", "GP1"]);
  const none = await post({ q: "قارن" });
  expect(none.body.intent).toBe("clarify");
  expect(none.body.suggestions.length).toBeGreaterThan(0);
  // codes from another agency are not loaded
  const alien = await post({ q: "compare", previousContext: { job: "find_units", unitCodes: ["NOPE1", "NOPE2"] } });
  expect(alien.body.intent).toBe("clarify");

  // budget marker: from previousContext.maxPrice
  const pr = await post({ q: "prices in Gapville", previousContext: { job: "find_units", maxPrice: 3e6 } });
  expect(pr.body.cards.find((c) => c.kind === "price_range").budget.value).toBe(3e6);
  const nb = await post({ q: "prices in Gapville" });
  expect(nb.body.cards.find((c) => c.kind === "price_range").budget).toBeUndefined();

  // deltas: deals / brief / response time carry delta + deltaGood
  const deals = await post({ q: "deals this month" });
  const di = deals.body.cards.find((c) => c.kind === "metric_row").items[0];
  expect(di).toMatchObject({ delta: expect.any(Number), deltaGood: expect.any(Boolean) });
  const brief = await post({ q: "my activity today", mode: "reports" });
  expect(brief.body.cards.find((c) => c.kind === "metric_row").items.every((i) => typeof i.delta === "number")).toBe(true);
  const rt = await post({ q: "response time this month" });
  if (rt.body.intent === "crm_response_time") {
    const avg = rt.body.cards.find((c) => c.kind === "metric_row").items[0];
    if (typeof avg.value === "number") expect(avg).toHaveProperty("deltaGood");
  }

  // viewings by broker: key is the broker id
  const futureToday = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  await h.query(
    `INSERT INTO leads (agency_id, ref, name, phone_e164, phones, lawful_basis, stage, assigned_broker_id, follow_up_status, follow_up_kind, next_follow_up_at, last_contact_at)
     VALUES ($1, 902, 'Avatar Client', '+201022220098', ARRAY['+201022220098']::text[], 'client_request', 'viewing', $2, 'open', 'viewing', $3, now())`,
    [h.AGENCY_A, h.BROKERS.broker.id, futureToday]
  );
  const v = await post({ q: "viewings today" });
  const bar = v.body.cards.find((c) => c.kind === "bar_breakdown");
  if (bar) expect(bar.rows[0].key).toBe(h.BROKERS.broker.id);
});

test("stale units answer: count equals the Dashboard stale count; a broker sees only their own; wordings route to it", async () => {
  const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
  await h.insertListing({ code: "ST-1", broker_id: h.BROKERS.broker.id });
  await h.insertListing({ code: "ST-2", broker_id: h.BROKERS.colleague.id });
  await h.insertListing({ code: "ST-NEW", broker_id: h.BROKERS.broker.id });
  await h.query("UPDATE listings SET confirmed_at = $2, updated_at = $2 WHERE agency_id = $1 AND code IN ('ST-1', 'ST-2')", [h.AGENCY_A, old]);
  const admin = await auth("admin");
  const dash = (await api().get("/api/v1/dashboard").set(admin)).body.units.stale;
  expect(dash).toBeGreaterThanOrEqual(2);
  for (const q of ["stale units", "الوحدات اللي متحدثتش"]) {
    const r = await api().post("/api/v1/assistant/query").set(admin).send({ q, mode: "auto" });
    expect(r.body).toMatchObject({ intent: "crm_stale_units", aiUsed: false });
    expect(r.body.cards[0].items[0].value).toBe(dash);
    expect(r.body.suggestions.length).toBeGreaterThan(0);
  }
  const mine = await api().post("/api/v1/assistant/query").set(await auth("broker")).send({ q: "stale units", mode: "auto" });
  expect(mine.body.cards[0].items[0].value).toBe(1);
  expect(JSON.stringify(mine.body.cards)).not.toContain("ST-2");
});

test("unit search returns the understood filters as structured fields", async () => {
  const hdr = await auth("admin");
  const r = await api().post("/api/v1/assistant/query").set(hdr).send({ q: "3 bedroom apartment in New Cairo under 9M ready to move fully finished", mode: "auto" });
  expect(r.status).toBe(200);
  expect(r.body.understood.filters).toMatchObject({
    bedrooms: { min: 3, max: null },
    propertyTypes: expect.arrayContaining(["apartment"]),
    price: { min: null, max: 9000000 },
    delivery: { ready: true, byYear: null }
  });
  expect(r.body.understood.filters.places.length).toBeGreaterThan(0);
  expect(r.body.understood.filters.finishing.length).toBeGreaterThan(0);
});

test("primary: 1-3 projects with priced offers are answered from the code-built line, the AI is not called", async () => {
  const Assistant = require("../../services/assistant");
  const AssistantQuery = require("../../services/assistantQuery");
  const spy = jest.spyOn(Assistant, "ask").mockRejectedValue(new Error("AI must not run"));
  try {
    const p = (await h.query("INSERT INTO projects (agency_id, name, name_en, district, city, status) VALUES ($1, 'ميڤيدا', 'Mivida', 'New Cairo', 'Cairo', 'selling') RETURNING id", [h.AGENCY_A]))[0];
    await h.query("INSERT INTO project_offers (agency_id, project_id, area, bedrooms, price, down, years) VALUES ($1, $2, 175, 3, 6200000, 620000, 8)", [h.AGENCY_A, p.id]);
    await h.query("UPDATE projects SET notes = $2 WHERE id = $1", [p.id, "شقة 175 م سعرها = 6,200,000 مقدم 10% = 620,000 تقسيط 8 سنين"]);
    const admin = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];
    const r = await AssistantQuery.query(h.pool, { AI, actor: admin, text: "Mivida payment plan", mode: "primary", lang: "en" });
    expect(r.intent).toBe("primary");
    expect(spy).not.toHaveBeenCalled();
    expect(r.cards[0].source).toBe("local");
    expect(r.cards[0].answer).toMatch(/6,200,000/);
    expect(r.headline).toBe("Primary & Developer Projects"); // request lang wins over the profile language
  } finally {
    spy.mockRestore();
  }
});

test("role-limited reports answer with a role message and the broker's own shortcuts, never a dead end", async () => {
  const AssistantQuery = require("../../services/assistantQuery");
  const broker = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.broker.id]))[0];
  const r = await AssistantQuery.query(h.pool, { AI, actor: broker, text: "broker ranking this month", mode: "auto", lang: "en" });
  expect(r.notForRole).toBe(true);
  expect(r.headline).toMatch(/managers/i);
  expect(r.suggestions.map((s) => s.q)).toContain("my stats this month");
});

describe("clients who want X (crm_client_matches)", () => {
  async function seedRequests() {
    const LeadRequests = require("../../services/leadRequests");
    const admin = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];
    const mk = async (phone, name, to, filters) => {
      const lead = (await Leads.captureLead(h.pool, admin, { phones: phone, name, assignTo: to.id })).lead;
      const r = await LeadRequests.saveRequest(h.pool, admin, lead.id, filters);
      expect(r.ok).toBe(true);
      return lead;
    };
    await mk("01077770001", "Apt Client", h.BROKERS.broker, { property_types: ["apartment"], places: [{ kind: "area", key: "new_cairo" }] });
    await mk("01077770002", "Villa Client", h.BROKERS.colleague, { property_types: ["villa"], places: [{ kind: "area", key: "sheikh_zayed" }] });
  }
  const ask = (hdr, q) => api().post("/api/v1/assistant/query").set(hdr).send({ q, mode: "auto" });

  test("manager sees every matching client, no phones, card contract fields", async () => {
    await seedRequests();
    const res = await ask(await auth("admin"), "which clients want an apartment in new cairo");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ intent: "crm_client_matches", aiUsed: false });
    expect(res.body.suggestions.length).toBeGreaterThanOrEqual(1);
    const card = res.body.cards.find((c) => c.kind === "client_matches");
    expect(card).toMatchObject({ total: 1, queue: null });
    expect(card.items[0]).toMatchObject({ ref: expect.stringMatching(/^L-\d+$/), name: "Apt Client", brokerId: h.BROKERS.broker.id, wants: expect.any(String), matchCount: expect.any(Number) });
    expect(JSON.stringify(res.body)).not.toMatch(/0107777|2010777/);
    const all = await ask(await auth("admin"), "clients looking for something");
    expect(all.body.cards[0].total).toBe(2);
  });

  test("a broker only sees their own clients when the agency switch is off; Arabic and prefix routes work", async () => {
    await seedRequests();
    await h.query("UPDATE agencies SET crm_settings = crm_settings || '{\"brokers_see_all_leads\": false}'::jsonb WHERE id = $1", [h.AGENCY_A]);
    const hdr = await auth("broker");
    const own = await ask(hdr, "مين من العملاء عايز شقة في التجمع");
    expect(own.body.cards[0].total).toBe(1);
    const other = await ask(hdr, "عملاء: فيلا في زايد");
    expect(other.body.intent).toBe("crm_client_matches");
    expect(other.body.cards[0].total).toBe(0);
  });

  test("bedrooms and price must overlap; an empty request range still matches", async () => {
    const LeadRequests = require("../../services/leadRequests");
    const admin = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];
    const nc = { property_types: ["apartment"], places: [{ kind: "area", key: "new_cairo" }] };
    const reqs = { "Three Bed": { ...nc, bedrooms_min: 3, bedrooms_max: 4 }, "Two Bed Small": { ...nc, bedrooms_min: 2, bedrooms_max: 2, price_max: 3000000 }, "Luxury": { ...nc, price_min: 12000000 }, "Open": nc };
    let n = 0;
    for (const [name, f] of Object.entries(reqs)) {
      const lead = (await Leads.captureLead(h.pool, admin, { phones: `0107777100${n++}`, name, assignTo: h.BROKERS.broker.id })).lead;
      expect((await LeadRequests.saveRequest(h.pool, admin, lead.id, f)).ok).toBe(true);
    }
    const hdr = await auth("admin");
    const names = async (q) => (await ask(hdr, q)).body.cards[0].items.map((i) => i.name).sort();
    expect(await names("which clients want a 3 bedroom apartment in new cairo")).toEqual(["Luxury", "Open", "Three Bed"]);
    expect(await names("which clients want an apartment in new cairo under 9 million")).toEqual(["Open", "Three Bed", "Two Bed Small"]);
  });

  test("ambiguous wording asks which one, with exactly two prefixed chips; a client-wants wording stays a unit search", async () => {
    const hdr = await auth("admin");
    const mixed = await ask(hdr, "clients apartment new cairo");
    expect(mixed.body).toMatchObject({ intent: "clarify", clarifyKind: "units_or_clients" });
    expect(mixed.body.suggestions).toEqual([
      { label: "Find units", q: "وحدات: clients apartment new cairo" },
      { label: "Show clients", q: "عملاء: clients apartment new cairo" }
    ]);
    expect((await ask(hdr, mixed.body.suggestions[0].q)).body.intent).toBe("unit_search");
    expect((await ask(hdr, mixed.body.suggestions[1].q)).body.intent).toBe("crm_client_matches");
    expect((await ask(hdr, "my client wants an apartment in new cairo")).body.intent).toBe("unit_search");
  });
});
