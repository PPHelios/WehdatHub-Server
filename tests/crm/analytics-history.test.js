// tests/crm/analytics-history.test.js — Market analytics history (migrations 137-138): price and status triggers, the nightly
// search count (idempotent, runs before the 90-day prune, never stores text), market and funnel rows on fixtures with the privacy
// thresholds applied at write time, and the job's registration.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const Search = require("../../services/analyticsSearch");
const Collect = require("../../services/analyticsCollect");
const PriceSheets = require("../../services/priceSheets");
const LogRollup = require("../../lib/logRollup");
const Privacy = require("../../domain/analyticsPrivacy");
const Bands = require("../../domain/analyticsBands");
const { buildJobs } = require("../../lib/jobs");

jest.setTimeout(120000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const q = (sql, p) => h.pool.query(sql, p).then((r) => r.rows);
const AREA_C = "a0000000-0000-0000-0000-0000000000c1";
const AREA_P = "a0000000-0000-0000-0000-0000000000c2";

async function prices(listingId) {
  return q("SELECT price, source FROM listing_prices WHERE listing_id = $1 ORDER BY changed_at, id", [listingId]);
}
const events = (listingId) => q("SELECT from_status, to_status, price_at_change, approx FROM listing_status_events WHERE listing_id = $1 ORDER BY id", [listingId]);

describe("price history trigger", () => {
  test("the first price, each change and nothing for a no-op update", async () => {
    const l = await h.insertListing({ code: "T-1", price_value: 1000000 });
    expect(await prices(l.id)).toEqual([{ price: 1000000, source: "edit" }]);
    await q("UPDATE listings SET price_value = 1200000 WHERE id = $1", [l.id]);
    expect((await prices(l.id)).map((r) => r.price)).toEqual([1000000, 1200000]);
    await q("UPDATE listings SET price_value = 1200000, title = 'x' WHERE id = $1", [l.id]);
    await q("UPDATE listings SET title = 'y' WHERE id = $1", [l.id]);
    expect(await prices(l.id)).toHaveLength(2);
  });

  test("an older unit with no history keeps its old price at the first change", async () => {
    const l = await h.insertListing({ code: "T-2", price_value: 500000 });
    await q("DELETE FROM listing_prices WHERE listing_id = $1", [l.id]);
    await q("UPDATE listings SET price_value = 600000 WHERE id = $1", [l.id]);
    expect((await prices(l.id)).map((r) => r.price)).toEqual([500000, 600000]);
  });

  test("the price-sheet writer tags the trigger's row instead of adding a duplicate", async () => {
    const l = await h.insertListing({ code: "T-3", price_value: 1000000 });
    await q("UPDATE listings SET price_value = 1100000 WHERE id = $1", [l.id]);
    await PriceSheets.noteEdit(h.pool, l, 1100000, { source: "increase" });
    const rows = await prices(l.id);
    expect(rows.map((r) => r.price)).toEqual([1000000, 1100000]);
    expect(rows[1].source).toBe("increase");
  });

  test("a writer that records first and then updates the listing is not duplicated either", async () => {
    const l = await h.insertListing({ code: "T-4", price_value: 1000000 });
    await PriceSheets.noteEdit(h.pool, l, 1300000, { source: "sheet" });
    await q("UPDATE listings SET price_value = 1300000 WHERE id = $1", [l.id]);
    expect((await prices(l.id)).map((r) => r.price)).toEqual([1000000, 1300000]);
  });
});

describe("status events trigger", () => {
  test("a sale records from, to and the price at that moment; a no-op update records nothing", async () => {
    const l = await h.insertListing({ code: "S-1", price_value: 2000000 });
    expect(await events(l.id)).toEqual([]);
    await q("UPDATE listings SET title = 'same status' WHERE id = $1", [l.id]);
    await q("UPDATE listings SET status = 'active' WHERE id = $1", [l.id]);
    expect(await events(l.id)).toEqual([]);
    await q("UPDATE listings SET status = 'sold' WHERE id = $1", [l.id]);
    expect(await events(l.id)).toEqual([{ from_status: "active", to_status: "sold", price_at_change: 2000000, approx: false }]);
  });

  test("archiving, reactivating and deleting are each one event", async () => {
    const l = await h.insertListing({ code: "S-2" });
    await q("UPDATE listings SET status = 'archived' WHERE id = $1", [l.id]);
    await q("UPDATE listings SET status = 'active' WHERE id = $1", [l.id]);
    await q("UPDATE listings SET deleted_at = now() WHERE id = $1", [l.id]);
    expect((await events(l.id)).map((e) => `${e.from_status}>${e.to_status}`)).toEqual(["active>archived", "archived>active", "active>deleted"]);
  });
});

describe("nightly search count", () => {
  const NOW = new Date("2026-11-19T10:00:00Z");
  const search = (over) =>
    q(
      `INSERT INTO search_log (agency_id, broker_id, channel, query_text, source, used_filters, total, created_at)
       VALUES ($1, $2, 'web', $3, 'parser', $4::jsonb, $5, $6)`,
      [h.AGENCY_A, h.BROKERS.broker.id, over.text || "شقة للبيع 01001234567 عميلي أحمد", JSON.stringify(over.filters || {}), over.total ?? 3, over.at]
    );
  const daily = () => q("SELECT day::text, area_id, property_type, listing_type, bedroom_band, budget_band, searches, zero_result FROM analytics_search_daily ORDER BY day, searches DESC");

  beforeEach(async () => {
    await q("INSERT INTO areas (id, name_key, name_en, name_ar) VALUES ($1, 'sheikh zayed', 'Sheikh Zayed', 'الشيخ زايد') ON CONFLICT DO NOTHING", [AREA_P]);
  });

  test("counts finished days by band, keeps zero results, ignores today, and stores no text or ids", async () => {
    const f = { listing_type: "sale", property_types: ["apartment"], bedrooms_min: 3, bedrooms_max: 3, price_max: 4000000, area_scope: { areas: [AREA_C] } };
    await search({ at: "2026-11-16T09:00:00Z", filters: f });
    await search({ at: "2026-11-16T12:00:00Z", filters: f, total: 0 });
    await search({ at: "2026-11-17T12:00:00Z", filters: { listing_type: "rent" } });
    await search({ at: "2026-11-19T08:00:00Z", filters: f }); // today: not finished
    const r = await Search.rollThrough(h.pool, { now: NOW });
    expect(r.searches).toBe(3);
    const rows = await daily();
    expect(rows).toEqual([
      { day: "2026-11-16", area_id: AREA_C, property_type: "apartment", listing_type: "sale", bedroom_band: "3", budget_band: "3M-5M", searches: 2, zero_result: 1 },
      { day: "2026-11-17", area_id: null, property_type: "any", listing_type: "rent", bedroom_band: "any", budget_band: "any", searches: 1, zero_result: 0 }
    ]);
    const cols = (await q("SELECT column_name FROM information_schema.columns WHERE table_name = 'analytics_search_daily'")).map((c) => c.column_name);
    expect(cols.filter((c) => Privacy.FORBIDDEN.includes(c))).toEqual([]);
    expect(JSON.stringify(rows)).not.toMatch(/أحمد|0100/);
  });

  test("a rerun adds nothing; new days are added once", async () => {
    await search({ at: "2026-11-16T09:00:00Z", filters: { listing_type: "sale" } });
    await Search.rollThrough(h.pool, { now: NOW });
    const again = await Search.rollThrough(h.pool, { now: NOW });
    expect(again.searches).toBe(0);
    expect((await daily())[0].searches).toBe(1);
    const LATER = new Date("2026-11-21T10:00:00Z");
    await search({ at: "2026-11-20T09:00:00Z", filters: { listing_type: "sale" } });
    await Search.rollThrough(h.pool, { now: LATER });
    await Search.rollThrough(h.pool, { now: LATER });
    expect((await daily()).map((r) => `${r.day}:${r.searches}`)).toEqual(["2026-11-16:1", "2026-11-20:1"]);
  });

  test("the 90-day prune counts old searches first and then deletes them", async () => {
    await search({ at: "2026-07-01T09:00:00Z", filters: { listing_type: "sale" } });
    await search({ at: "2026-07-01T10:00:00Z", filters: { listing_type: "sale" }, total: 0 });
    await search({ at: "2026-11-10T10:00:00Z", filters: { listing_type: "rent" } });
    const out = await LogRollup.rollUp(h.pool, { now: NOW });
    expect(out.rolled_search_log).toBe(2);
    expect((await q("SELECT count(*)::int AS n FROM search_log"))[0].n).toBe(1);
    const rows = await daily();
    expect(rows.find((r) => r.day === "2026-07-01")).toMatchObject({ searches: 2, zero_result: 1 });
    // the nightly job later counts the rest without double counting July
    await Search.rollThrough(h.pool, { now: NOW });
    await Search.rollThrough(h.pool, { now: NOW }); // a long catch-up takes more than one run
    expect((await daily()).find((r) => r.day === "2026-07-01").searches).toBe(2);
    expect((await daily()).find((r) => r.day === "2026-11-10").searches).toBe(1);
  });

  test("when counting fails the old searches are not deleted", async () => {
    await search({ at: "2026-07-01T09:00:00Z", filters: {} });
    const spy = jest.spyOn(Search, "rollThrough").mockRejectedValue(new Error("count failed"));
    await expect(LogRollup.rollUp(h.pool, { now: NOW })).rejects.toThrow("count failed");
    spy.mockRestore();
    expect((await q("SELECT count(*)::int AS n FROM search_log"))[0].n).toBe(1);
  });
});

describe("market and funnel computation", () => {
  const FIVE = [];
  async function agencies(n) {
    for (let i = 0; i < n; i++) {
      const id = `c0000000-0000-0000-0000-00000000000${i}`;
      await q("INSERT INTO agencies (id, name) VALUES ($1, $2)", [id, `Fixture ${i}`]);
      await q("INSERT INTO brokers (id, agency_id, phone_number, name, role) VALUES ($1, $2, $3, 'Fixture Broker', 'broker')", [`d000000${i}-0000-0000-0000-000000000000`, id, `2010000100${i}0`]);
      FIVE.push(id);
    }
  }
  beforeEach(async () => {
    FIVE.length = 0;
    await q("INSERT INTO areas (id, name_key, name_en, name_ar) VALUES ($1, 'sheikh zayed', 'Sheikh Zayed', 'الشيخ زايد') ON CONFLICT DO NOTHING", [AREA_P]);
    await q("UPDATE areas SET parent_id = $1 WHERE id = $2", [AREA_P, AREA_C]);
  });

  test("a market cell with 5 agencies and 10 units is written; sold units give days to close and the price gap; a small area is not written", async () => {
    await agencies(5);
    const day = Bands.cairoDay(new Date());
    const sold = [];
    for (const a of FIVE) {
      for (let i = 0; i < 2; i++) {
        const l = await h.insertListing({ agency_id: a, code: `M-${a.slice(-1)}-${i}`, price_value: 1500000, area_value: 100, area_id: AREA_C, bedrooms: 3, owner_id: null });
        if (i === 0) sold.push(l);
      }
    }
    await h.insertListing({ agency_id: h.AGENCY_A, code: "LONE-1", area_value: 100, area_id: AREA_P, price_value: 3000000 });
    for (const l of sold) {
      await q("UPDATE listings SET created_at = now() - interval '40 days' WHERE id = $1", [l.id]);
      await q("UPDATE listings SET status = 'sold' WHERE id = $1", [l.id]);
      await q(
        `INSERT INTO deals (agency_id, ref, listing_id, closing_broker_id, deal_type, price, commission_mode, commission_total, client_name, client_phone, notes)
         VALUES ($1, $2, $3, $4, 'sale', 1425000, 'pct', 0, 'Zebulon Sentinelson', '01098761234', 'secret note')`,
        [l.agency_id, sold.indexOf(l) + 1, l.id, `d000000${l.agency_id.slice(-1)}-0000-0000-0000-000000000000`]
      );
    }
    const n = await Collect.runMarket(h.pool, day);
    expect(n).toBeGreaterThan(0);
    const rows = await q("SELECT * FROM analytics_market_daily WHERE area_id = $1 AND property_type = 'apartment' AND listing_type = 'sale' AND bedroom_band = '3'", [AREA_C]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agencies_n: 5, rows_n: 10, listings_active: 5, sold_count: 5, removed_listings: 5, new_listings: 5 });
    expect(Number(rows[0].median_days_to_close)).toBeGreaterThanOrEqual(39);
    expect(Number(rows[0].asking_vs_closed_pct)).toBe(-5);
    // the lone unit of one agency is not written as a cell of its own area (AREA_P only appears as the parent of AREA_C)
    expect((await q("SELECT 1 FROM analytics_market_daily WHERE area_id = $1 AND property_type = 'apartment' AND bedroom_band <> 'all'", [AREA_P]))).toHaveLength(0);
    // a rerun replaces the day, never doubles it
    await Collect.runMarket(h.pool, day);
    expect((await q("SELECT count(*)::int AS n FROM analytics_market_daily"))[0].n).toBe(n);
    // nothing personal anywhere in the table
    const dump = JSON.stringify(await q("SELECT * FROM analytics_market_daily"));
    expect(dump).not.toMatch(/Zebulon|01098761234|secret note|M-\d-\d|LONE-1/);
    const cols = (await q("SELECT column_name FROM information_schema.columns WHERE table_name = 'analytics_market_daily'")).map((c) => c.column_name);
    expect(cols.filter((c) => Privacy.FORBIDDEN.includes(c))).toEqual([]);
  });

  test("with 4 agencies no market detail row exists", async () => {
    await agencies(4);
    for (const a of FIVE) for (let i = 0; i < 4; i++) await h.insertListing({ agency_id: a, code: `F-${a.slice(-1)}-${i}`, area_value: 100, area_id: AREA_C });
    expect(await Collect.runMarket(h.pool, Bands.cairoDay(new Date()))).toBe(0);
  });

  test("the funnel keeps each agency's own row and a market row only with 5 agencies", async () => {
    await agencies(5);
    const month = `${Bands.cairoDay(new Date()).slice(0, 7)}-01`;
    for (const a of FIVE) {
      for (let i = 0; i < 4; i++) {
        await q(
          `INSERT INTO leads (agency_id, ref, name, phone_e164, phones, lawful_basis, stage, source, lost_reason, notes) VALUES ($1, $2, 'Mona Hidden', $3, ARRAY[$3], 'client_request', $4, 'facebook', $5, 'private note')`,
          [a, i + 1, `+20109876${a.slice(-1)}00${i}`, i === 0 ? "lost" : i === 1 ? "viewing" : "contacted", i === 0 ? "غالي" : null]
        );
      }
    }
    const written = await Collect.runFunnel(h.pool, month);
    expect(written).toBe(6);
    const market = (await q("SELECT * FROM analytics_funnel_monthly WHERE agency_id IS NULL"))[0];
    expect(market).toMatchObject({ agencies_n: 5, leads: 4, lost: 1 });
    const own = (await q("SELECT * FROM analytics_funnel_monthly WHERE agency_id = $1", [FIVE[0]]))[0];
    expect(own).toMatchObject({ leads: 4, lost: 1, viewings: 1 });
    expect(own.by_source).toEqual({ Facebook: 4 });
    expect(own.lost_reasons).toEqual({ price: 1 });
    expect(JSON.stringify(await q("SELECT * FROM analytics_funnel_monthly"))).not.toMatch(/Mona|private note|\+20109876|غالي/);
    // fewer than 5 agencies: own rows only
    await q("DELETE FROM leads WHERE agency_id = $1", [FIVE[4]]);
    expect(await Collect.runFunnel(h.pool, month)).toBe(4);
    expect(await q("SELECT 1 FROM analytics_funnel_monthly WHERE agency_id IS NULL")).toHaveLength(0);
  });
});

describe("the nightly job", () => {
  test("is registered once, with a name the owner's job list shows", () => {
    expect(buildJobs({}).filter((j) => j.name === "analytics_nightly")).toHaveLength(1);
  });

  test("a run records counts and the last-run time, then the same day does nothing; before 02:00 Cairo it waits", async () => {
    const now = new Date("2026-11-19T05:00:00Z"); // 07:00 Cairo
    const first = await Collect.runOnce(h.pool, { now, watermark: {} });
    expect(first.watermark).toEqual({ day: "2026-11-19" });
    const meta = (await q("SELECT value FROM analytics_meta WHERE key = 'last_run'"))[0].value;
    expect(meta.day).toBe("2026-11-19");
    expect(meta.tables).toHaveProperty("market_daily");
    expect(await Collect.runOnce(h.pool, { now, watermark: first.watermark })).toEqual({ counts: {} });
    const early = new Date("2026-11-19T21:30:00Z"); // 23:30 Cairo? no: 2026-11-19 23:30 Cairo is not before 02:00
    expect((await Collect.runOnce(h.pool, { now: early, watermark: { day: "2026-11-19" } })).counts).toBeDefined();
    const night = new Date("2026-11-19T22:30:00Z"); // 00:30 Cairo on the 20th: wait for 02:00
    expect(await Collect.runOnce(h.pool, { now: night, watermark: { day: "2026-11-19" } })).toEqual({ counts: {} });
  });
});
