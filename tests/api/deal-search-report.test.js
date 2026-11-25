"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");
const Leads = require("../../services/leads");
const Deals = require("../../services/deals");

jest.setTimeout(90000);
afterAll(closeHarness);

test("closed deal buckets match the lead-scoped list and exclude cancelled deals", async () => {
  const h = await createHarness();
  const actor = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];
  await h.insertListing({ code: "VIL-08" });
  const lead = (await Leads.captureLead(h.pool, actor, { phones: "01012345678", name: "Fixture" })).lead;
  const r = await Deals.createDeal(h.pool, actor, { leadKey: lead.ref, unitCode: "VIL-08", price: 8500000, mode: "pct", pct: 2 });
  expect(r.ok).toBe(true);
  const code = await WebAuth.issueLoginCode(h.pool, actor);
  const api = request(h.app.app);
  const login = await api.post("/api/v1/auth/code/verify").send({ phone: h.BROKERS.admin.phone, code });
  const get = (suffix = "") => api.get("/api/v1/deals?report=recent" + suffix).set("Authorization", "Bearer " + login.body.token);
  const full = await get();
  expect(full.status).toBe(200);
  expect(full.body.items).toHaveLength(1);
  expect(full.body.summary.weeks.reduce((a, b) => a + b, 0)).toBe(1);
  const week = full.body.summary.weeks.indexOf(1);
  expect((await get("&week=" + week)).body.items).toEqual(full.body.items);
  expect((await get("&week=" + ((week + 1) % 4))).body.items).toEqual([]);
  const sources = () => api.get("/api/v1/sources?signed=1").set("Authorization", "Bearer " + login.body.token);
  expect((await sources()).body.totals.deals).toBe(0);
  await h.pool.query("UPDATE deals SET status = 'signed' WHERE agency_id = $1", [actor.agency_id]);
  expect((await sources()).body.totals.deals).toBe(1);
  await h.pool.query("UPDATE deals SET status = 'cancelled' WHERE agency_id = $1", [actor.agency_id]);
  expect((await get()).body.items).toEqual([]);
  expect((await get()).body.summary.weeks.every((n) => n === 0)).toBe(true);
});

test("Deals.createDeal snapshots market and canonical area on deals so later unit deletion/edit preserves historical market/area", async () => {
  const h = await createHarness();
  const actor = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];
  await h.insertListing({
    code: "PR-10",
    market: "primary",
    inventory_type: "primary_unit",
    compound: "Hyde Park",
    district: "New Cairo",
    area_id: "a0000000-0000-0000-0000-0000000000c1",
    price_value: 6000000
  });
  const lead = (await Leads.captureLead(h.pool, actor, { phones: "01022223333", name: "Snapshot Buyer" })).lead;
  const r = await Deals.createDeal(h.pool, actor, { leadKey: lead.ref, unitCode: "PR-10", price: 6000000, mode: "pct", pct: 2 });
  expect(r.ok).toBe(true);
  expect(r.deal.market).toBe("primary");
  expect(r.deal.area_key).toBe("new cairo");
  expect(r.deal.area_label).toBe("New Cairo");

  // Unlink/delete unit after deal close: historical snapshot on deal stays untouched.
  await h.pool.query("UPDATE deals SET listing_id = NULL WHERE id = $1", [r.deal.id]);
  await h.pool.query("DELETE FROM listings WHERE code = 'PR-10' AND agency_id = $1", [actor.agency_id]);
  const [stored] = await h.query("SELECT market, area_key, area_label FROM deals WHERE id = $1", [r.deal.id]);
  expect(stored).toEqual({ market: "primary", area_key: "new cairo", area_label: "New Cairo" });
});

test("dealsSummary & GET /api/v1/deals separate closer vs participant without double counting, enforce [from, to) & personal team_lead scope, and track unknownMarketCount separately from unknownAreaCount", async () => {
  const h = await createHarness();
  const admin = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];
  const b1 = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.broker.id]))[0];
  const b2 = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.colleague.id]))[0];
  await h.query("UPDATE brokers SET name = 'Sara', preferred_lang = 'en' WHERE id = $1", [b1.id]);
  await h.query("UPDATE brokers SET name = 'Omar', preferred_lang = 'en' WHERE id = $1", [b2.id]);

  await h.insertListing({ code: "RS-A", broker_id: b2.id, market: "resale", compound: "Hyde Park", district: "New Cairo", area_id: "a0000000-0000-0000-0000-0000000000c1", price_value: 4000000 });
  await h.insertListing({ code: "RS-B", broker_id: b1.id, market: "resale", compound: "Hyde Park", district: "New Cairo", area_id: "a0000000-0000-0000-0000-0000000000c1", price_value: 5000000 });

  const lead1 = (await Leads.captureLead(h.pool, b2, { phones: "01077770001", name: "C1" })).lead;
  const lead2 = (await Leads.captureLead(h.pool, b1, { phones: "01077770002", name: "C2" })).lead;
  const lead3 = (await Leads.captureLead(h.pool, admin, { phones: "01077770003", name: "C3" })).lead;

  // Deal 1: Omar closes (resale, New Cairo), Sara has a 30% split -> closer=Omar, participant includes Sara.
  const d1 = await Deals.createDeal(h.pool, admin, {
    leadKey: lead1.ref, unitCode: "RS-A", price: 4000000, mode: "amount", amount: 100000,
    closingBrokerId: b2.id, splits: [{ brokerId: b1.id, pct: 30 }, { brokerId: b2.id, pct: 70 }], status: "signed"
  });
  // Deal 2: Sara closes alone (resale, New Cairo).
  const d2 = await Deals.createDeal(h.pool, admin, {
    leadKey: lead2.ref, unitCode: "RS-B", price: 5000000, mode: "amount", amount: 150000,
    closingBrokerId: b1.id, splits: [{ brokerId: b1.id, pct: 100 }], status: "paid"
  });
  // Deal 3: No unit linked (unknown market + unknown area) inside the window.
  const d3 = await Deals.createDeal(h.pool, admin, {
    leadKey: lead3.ref, price: 2000000, mode: "amount", amount: 50000,
    closingBrokerId: b2.id, status: "signed"
  });
  expect(d1.ok && d2.ok && d3.ok).toBe(true);

  const summaryCloserSara = await Deals.dealsSummary(h.pool, admin, { brokerId: b1.id, brokerRole: "closer" });
  expect(summaryCloserSara.deals).toBe(1);
  expect(summaryCloserSara.commissionTotal).toBe(150000);
  expect(summaryCloserSara.brokerShareTotal).toBe(150000);

  const summaryPartSara = await Deals.dealsSummary(h.pool, admin, { brokerId: b1.id, brokerRole: "participant" });
  expect(summaryPartSara.deals).toBe(2);
  expect(summaryPartSara.commissionTotal).toBe(250000);
  expect(summaryPartSara.brokerShareTotal).toBe(180000); // 30% of 100k + 150k, zero double-count

  const summaryAll = await Deals.dealsSummary(h.pool, admin, { market: "resale", area: "new cairo" });
  expect(summaryAll.deals).toBe(2);
  expect(summaryAll.unknownMarketCount).toBe(1);
  expect(summaryAll.unknownAreaCount).toBe(1);

  const code = await WebAuth.issueLoginCode(h.pool, admin);
  const api = request(h.app.app);
  const token = (await api.post("/api/v1/auth/code/verify").send({ phone: h.BROKERS.admin.phone, code })).body.token;
  const badRange = await api.get("/api/v1/deals?from=2023-01-01&to=2026-11-20").set("Authorization", `Bearer ${token}`);
  expect(badRange.status).toBe(422);
  expect(badRange.body.error).toBe("range_too_large");

  // Team lead remains strictly personal on Deals even when passing brokerId for someone else.
  await h.query("UPDATE brokers SET role = 'team_lead' WHERE id = $1", [b1.id]);
  const tlCode = await WebAuth.issueLoginCode(h.pool, b1);
  const tlTok = (await api.post("/api/v1/auth/code/verify").send({ phone: h.BROKERS.broker.phone, code: tlCode })).body.token;
  const tlDeals = await api.get(`/api/v1/deals?broker=${b2.id}&brokerRole=closer`).set("Authorization", `Bearer ${tlTok}`);
  expect(tlDeals.status).toBe(200);
  expect(tlDeals.body.items.every((x) => x.closing_broker_id === b1.id || x.my_share != null)).toBe(true);
});
