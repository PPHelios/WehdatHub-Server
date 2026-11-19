// tests/web/analytics.test.js — Market analytics access: the owner's tab and CSV, the per-agency switch, the agency's Market page
// (managers and owner only, own funnel only, switch on only), and that no page, CSV or response holds a name or a phone.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const { resetConfig } = require("../../config");
const Analytics = require("../../services/analytics");
const Collect = require("../../services/analyticsCollect");
const Bands = require("../../domain/analyticsBands");
const Privacy = require("../../domain/analyticsPrivacy");

jest.setTimeout(120000);

const AREA_X = "a0000000-0000-0000-0000-0000000000c1"; // New Cairo (the fixture area)
const AREA_Y = "a0000000-0000-0000-0000-0000000000c9";
const MANAGER_B = { id: "20000000-0000-0000-0000-000000000077", agency_id: "b0000000-0000-0000-0000-00000000000b", phone: "201000000077", role: "manager", name: "Beta Manager", lang: "en" };
const SECRET_NAME = "Zebulon Sentinelson";
const SECRET_PHONE = "01098761234";

let h;
const q = (sql, p) => h.pool.query(sql, p).then((r) => r.rows);

beforeEach(async () => {
  h = await createHarness();
  process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
  resetConfig();
  await h.seedBroker("manager");
  await h.seedBroker("owner");
  await q("INSERT INTO brokers (id, agency_id, phone_number, name, role, is_active, preferred_lang) VALUES ($1, $2, $3, $4, $5, true, $6)", [MANAGER_B.id, MANAGER_B.agency_id, MANAGER_B.phone, MANAGER_B.name, MANAGER_B.role, MANAGER_B.lang]);
  await q("INSERT INTO areas (id, name_key, name_en, name_ar) VALUES ($1, 'sixth of october', 'Sixth of October', 'السادس من أكتوبر')", [AREA_Y]);
  const month = `${Bands.cairoDay(new Date()).slice(0, 7)}-01`;
  // Own funnel rows with recognisable numbers, and the market median.
  await q("INSERT INTO analytics_funnel_monthly (month, agency_id, leads, contacted, viewings, deals, lost, rates) VALUES ($1, $2, 77, 60, 20, 5, 10, '{\"contacted_pct\":77.9}')", [month, h.AGENCY_A]);
  await q("INSERT INTO analytics_funnel_monthly (month, agency_id, leads, contacted, viewings, deals, lost, rates) VALUES ($1, $2, 888, 700, 200, 50, 100, '{\"contacted_pct\":78.8}')", [month, h.AGENCY_B]);
  await q("INSERT INTO analytics_funnel_monthly (month, agency_id, leads, contacted, viewings, deals, lost, rates, agencies_n) VALUES ($1, NULL, 40, 30, 10, 3, 5, '{\"contacted_pct\":75}', 6)", [month]);
  const day = Bands.cairoDay(new Date());
  for (const [area, p50] of [[AREA_X, 21111], [AREA_Y, 33333]]) {
    await q("INSERT INTO analytics_market_daily (day, area_id, property_type, listing_type, bedroom_band, listings_active, price_m2_p25, price_m2_p50, price_m2_p75, agencies_n, rows_n) VALUES ($1, $2, 'apartment', 'sale', 'all', 30, 10000, $3, 40000, 6, 30)", [day, area, p50]);
    await q("INSERT INTO analytics_search_daily (day, area_id, property_type, listing_type, bedroom_band, budget_band, searches, zero_result) VALUES ($1, $2, 'apartment', 'sale', '3', '3M-5M', 25, 12)", [day, area]);
  }
  await q("INSERT INTO analytics_search_daily (day, area_id, property_type, listing_type, bedroom_band, budget_band, searches, zero_result) VALUES ($1, $2, 'villa', 'rent', 'any', 'any', 3, 1)", [day, AREA_X]);
  // Agency A has a unit in area X only.
  await h.insertListing({ code: "OWN-1", area_id: AREA_X, owner_id: null });
});
afterAll(async () => {
  delete process.env.OWNER_BROKER_IDS;
  resetConfig();
  await closeHarness();
});

const enable = async (agencyId, on = true) => {
  const owner = await signIn(h, "admin");
  return owner.agent.post(`/app/owner/agencies/${agencyId}/analytics`).type("form").send({ on: on ? "1" : "0", _csrf: owner.csrf });
};

describe("the switch", () => {
  test("off by default: the manager gets the ordinary 404 and no menu item", async () => {
    const m = await signIn(h, "manager");
    expect((await m.agent.get("/app/market")).status).toBe(404);
    const home = await m.agent.get("/app/");
    expect(home.text).not.toContain('href="/app/market"');
    expect((await q("SELECT analytics_enabled FROM agencies WHERE id = $1", [h.AGENCY_A]))[0].analytics_enabled).toBe(false);
  });

  test("the owner switches it on from the agency page; managers then see it and the menu shows it", async () => {
    const owner = await signIn(h, "admin");
    const page = await owner.agent.get(`/app/owner/agencies/${h.AGENCY_A}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('data-analytics-enabled="0"');
    const r = await enable(h.AGENCY_A);
    expect(r.status).toBe(200);
    expect(r.text).toContain('data-analytics-enabled="1"');
    const m = await signIn(h, "manager");
    const res = await m.agent.get("/app/market");
    expect(res.status).toBe(200);
    const home = await m.agent.get("/app/more");
    expect(home.text).toContain('href="/app/market"');
    // and off again: 404 at once
    await enable(h.AGENCY_A, false);
    expect((await m.agent.get("/app/market")).status).toBe(404);
  });

  test("only the product owner can switch it; a manager's own attempt is the ordinary 404 and changes nothing", async () => {
    const m = await signIn(h, "manager");
    const r = await m.agent.post(`/app/owner/agencies/${h.AGENCY_A}/analytics`).type("form").send({ on: "1", _csrf: m.csrf });
    expect(r.status).toBe(404);
    expect((await q("SELECT analytics_enabled FROM agencies WHERE id = $1", [h.AGENCY_A]))[0].analytics_enabled).toBe(false);
    expect(await Analytics.setEnabled(h.pool, h.BROKERS.manager, h.AGENCY_A, true)).toEqual({ error: "forbidden" });
  });
});

describe("who may read", () => {
  test("brokers are refused even when the switch is on; managers and the agency owner are served", async () => {
    await enable(h.AGENCY_A);
    for (const who of ["broker", "colleague"]) {
      const s = await signIn(h, who);
      expect((await s.agent.get("/app/market")).status).toBe(404);
      expect((await s.agent.get("/app/")).text).not.toContain('href="/app/market"');
    }
    for (const who of ["manager", "owner"]) {
      const s = await signIn(h, who);
      expect((await s.agent.get("/app/market")).status).toBe(200);
    }
    expect(await Analytics.forAgency(h.pool, h.BROKERS.broker)).toEqual({ error: "forbidden" });
  });

  test("an agency whose switch is off cannot read, even while another agency's is on", async () => {
    await enable(h.AGENCY_A);
    expect(await Analytics.forAgency(h.pool, MANAGER_B)).toEqual({ error: "disabled" });
    const b = await signIn(h, MANAGER_B);
    expect((await b.agent.get("/app/market")).status).toBe(404);
  });

  test("an agency reads its own funnel row only, never another agency's (the id comes from the session)", async () => {
    await enable(h.AGENCY_A);
    await enable(MANAGER_B.agency_id);
    const a = await Analytics.forAgency(h.pool, h.BROKERS.manager);
    const b = await Analytics.forAgency(h.pool, MANAGER_B);
    expect(a.agencyFunnel.map((r) => r.leads)).toEqual([77]);
    expect(b.agencyFunnel.map((r) => r.leads)).toEqual([888]);
    expect(JSON.stringify(a)).not.toContain("888");
    expect(JSON.stringify(b)).not.toMatch(/\b77\b/);
    expect(a.marketFunnel.map((r) => r.leads)).toEqual([40]);
    const m = await signIn(h, "manager");
    const html = (await m.agent.get("/app/market?agency_id=" + MANAGER_B.agency_id)).text;
    expect(html).toContain(">77<");
    expect(html).not.toContain(">888<");
    // the exported surface has no function that takes another agency's id on the agency path
    expect(Analytics.forAgency.length).toBeLessThanOrEqual(2);
  });

  test("the agency's market reports cover only the places where it has units", async () => {
    await enable(h.AGENCY_A);
    const m = await signIn(h, "manager");
    const html = (await m.agent.get("/app/market")).text;
    expect(html).toContain("21,111");
    expect(html).not.toContain("33,333");
    expect(html).not.toContain("Sixth of October");
    expect(html).not.toContain("السادس من أكتوبر");
  });
});

describe("the owner's tab and CSV", () => {
  test("the tab shows the last run, row counts, the switches, the reports and 'not enough data' for small cells", async () => {
    const owner = await signIn(h, "admin");
    const picked = await owner.agent.get(`/app/owner?an_agency=${h.AGENCY_A}`);
    expect(picked.text).toContain(">77<");
    await Collect.runOnce(h.pool, { now: new Date(), force: true });
    const res = await owner.agent.get("/app/owner");
    expect(res.status).toBe(200);
    expect(res.text).toContain("data-analytics-status");
    expect(res.text).toContain("data-last-run");
    expect(res.text).toContain("data-count=\"market_daily\"");
    expect(res.text).toContain("data-agency-switch");
    expect(res.text).toContain("Not enough data"); // the villa/rent cell has 3 searches
    expect(res.text).toContain("data-hot"); // 12 of 25 searches found nothing
  });

  test("the agency list switch from the tab turns the agency on", async () => {
    const owner = await signIn(h, "admin");
    const r = await owner.agent.post(`/app/owner/agencies/${h.AGENCY_B}/analytics`).type("form").send({ on: "1", from: "tab", _csrf: owner.csrf });
    expect(r.status).toBe(200);
    expect(r.text).toContain("data-analytics-status");
    expect((await q("SELECT analytics_enabled FROM agencies WHERE id = $1", [h.AGENCY_B]))[0].analytics_enabled).toBe(true);
  });

  test("CSV export: owner only, fixed columns, and nothing personal even when the source rows hold names and phones", async () => {
    await q("INSERT INTO leads (agency_id, ref, name, phone_e164, phones, lawful_basis, stage, source, notes) VALUES ($1, 1, $2, '+201098761234', ARRAY['+201098761234'], 'client_request', 'new', $3, 'private note')", [h.AGENCY_A, SECRET_NAME, `walk ${SECRET_PHONE}`]);
    await Collect.runOnce(h.pool, { now: new Date(), force: true });
    const owner = await signIn(h, "admin");
    for (const t of ["market_daily", "funnel_monthly", "search_daily"]) {
      const r = await owner.agent.get(`/app/owner/analytics/${t}.csv`);
      expect(r.status).toBe(200);
      expect(r.headers["content-type"]).toMatch(/text\/csv/);
      expect(r.text).not.toContain(SECRET_NAME);
      expect(r.text).not.toContain(SECRET_PHONE);
      expect(r.text).not.toContain("private note");
      expect(r.text).not.toMatch(/\+?20\d{10}/);
      const header = r.text.replace(/^﻿/, "").split("\r\n")[0].split(",");
      expect(header.filter((c) => Privacy.FORBIDDEN.includes(c))).toEqual([]);
    }
    expect((await owner.agent.get("/app/owner/analytics/leads.csv")).status).toBe(404);
    const m = await signIn(h, "manager");
    expect((await m.agent.get("/app/owner/analytics/market_daily.csv")).status).toBe(404);
  });

  test("no page the feature draws holds a name, phone or note from the source tables", async () => {
    await q("INSERT INTO leads (agency_id, ref, name, phone_e164, phones, lawful_basis, stage, source, lost_reason, notes) VALUES ($1, 1, $2, '+201098761234', ARRAY['+201098761234'], 'client_request', 'lost', $3, $3, 'private note')", [h.AGENCY_A, SECRET_NAME, `${SECRET_NAME} ${SECRET_PHONE}`]);
    await Collect.runOnce(h.pool, { now: new Date(), force: true });
    await enable(h.AGENCY_A);
    const owner = await signIn(h, "admin");
    const m = await signIn(h, "manager");
    const pages = [(await owner.agent.get("/app/owner")).text, (await owner.agent.get(`/app/owner?an_agency=${h.AGENCY_A}`)).text, (await m.agent.get("/app/market")).text];
    for (const text of pages) {
      expect(text).not.toContain(SECRET_NAME);
      expect(text).not.toContain(SECRET_PHONE);
      expect(text).not.toContain("private note");
    }
  });
});
