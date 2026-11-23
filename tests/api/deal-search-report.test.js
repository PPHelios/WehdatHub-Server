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
