// tests/web/units-filters.test.js — The Units list: fixed-list filters (type, furnishing, finishing), the agency's own
// compounds, a search on the code, 20 per page with the total, and the finishing migration (old free text → fixed list).
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const { mapFinishing } = require("../../domain/furnishingStatus");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const codesOn = (text) => [...text.matchAll(/data-code="([^"]+)"/g)].map((m) => m[1]);

async function seedUnits() {
  const base = { broker_id: h.BROKERS.broker.id };
  await h.insertListing({ ...base, code: "VIL-01", compound: "Hyde Park", property_type: "villa", furnishing: "furnished", finishing: "fully_finished" });
  await h.insertListing({ ...base, code: "APT-02", compound: "Hyde Park", property_type: "apartment", furnishing: "unfurnished", finishing: "semi_finished" });
  await h.insertListing({ ...base, code: "APT-03", compound: "Mountain View", property_type: "apartment", furnishing: "furnished", finishing: null });
  await h.insertListing({ ...base, code: "OLD-04", compound: "Mountain View", property_type: "villa", status: "sold" });
}

test("filters by compound, type, furnishing and finishing, and searches on the code", async () => {
  await seedUnits();
  const a = await signIn(h, "admin");
  const get = (qs) => a.agent.get(`/app/units?lang=en&${qs}`);

  expect(codesOn((await get("")).text).sort()).toEqual(["APT-02", "APT-03", "VIL-01"]);
  expect(codesOn((await get("compound=hyde%20park")).text).sort()).toEqual(["APT-02", "VIL-01"]);
  expect(codesOn((await get("type=villa")).text)).toEqual(["VIL-01"]);
  expect(codesOn((await get("furnishing=furnished")).text).sort()).toEqual(["APT-03", "VIL-01"]);
  expect(codesOn((await get("finishing=semi_finished")).text)).toEqual(["APT-02"]);
  expect(codesOn((await get("q=apt-")).text).sort()).toEqual(["APT-02", "APT-03"]);
  expect(codesOn((await get("compound=Hyde%20Park&type=apartment")).text)).toEqual(["APT-02"]);
  // An unknown value is ignored, never turned into a free-text match.
  expect(codesOn((await get("type=spaceship&compound=Nowhere")).text)).toHaveLength(3);
  // The sold tab keeps the same filters.
  expect(codesOn((await get("status=sold&type=villa")).text)).toEqual(["OLD-04"]);
});

test("the compound dropdown lists only the agency's compounds; the filters are fixed lists", async () => {
  await seedUnits();
  await h.insertListing({ agency_id: h.AGENCY_B, broker_id: h.BROKERS.rival.id, code: "RIV-01", compound: "Rival Heights" });
  const a = await signIn(h, "admin");
  const page = (await a.agent.get("/app/units?lang=en")).text;
  expect(page).toMatch(/<datalist id="unit-compounds"><option value="Hyde Park">2<\/option><option value="Mountain View">1<\/option><\/datalist>/);
  expect(page).not.toContain("Rival Heights");
  expect(page).toMatch(/<select name="finishing">[\s\S]*value="ultra_super_lux"/);
  expect(page).toMatch(/<select name="furnishing">[\s\S]*value="kitchen_and_ac"/);
  expect(page).toMatch(/<select name="type">[\s\S]*value="penthouse"/);
});

test("20 a page with the total, and Previous/Next keep the filters", async () => {
  for (let i = 1; i <= 45; i++) await h.insertListing({ broker_id: h.BROKERS.broker.id, code: `PG-${String(i).padStart(2, "0")}`, compound: "Palm Hills" });
  const a = await signIn(h, "admin");
  const p0 = (await a.agent.get("/app/units?lang=en&compound=Palm%20Hills")).text;
  expect(p0).toMatch(/data-total="45"/);
  expect(p0).toMatch(/45 unit\(s\) · page 1 of 3/);
  expect(codesOn(p0)).toHaveLength(20);
  expect(p0).toMatch(/href="\/app\/units\?[^"]*compound=Palm\+Hills[^"]*page=1"[^>]*>Next/);
  const p2 = (await a.agent.get("/app/units?lang=en&compound=Palm%20Hills&page=2")).text;
  expect(codesOn(p2)).toHaveLength(5);
  expect(p2).toMatch(/Previous/);
  expect(p2).not.toMatch(/Next →/);
});

test("the finishing migration maps old entries to the fixed list and blanks the rest", async () => {
  const mod = require("../../db/migrations/074_finishing_status");
  const base = { broker_id: h.BROKERS.broker.id };
  await h.insertListing({ ...base, code: "F-1", finishing: "سوبر لوكس" });
  await h.insertListing({ ...base, code: "F-2", finishing: "تشطيب كامل" });
  await h.insertListing({ ...base, code: "F-3", finishing: "something odd" });
  await h.insertListing({ ...base, code: "F-4", finishing: null, details: { finishing: "نصف تشطيب" } });
  await h.insertListing({ ...base, code: "F-5", finishing: "fully_finished" });
  await mod.up(h.pool);
  const rows = await h.query("SELECT code, finishing FROM listings WHERE code LIKE 'F-%' ORDER BY code");
  expect(rows).toEqual([
    { code: "F-1", finishing: "super_lux" },
    { code: "F-2", finishing: "fully_finished" },
    { code: "F-3", finishing: null },
    { code: "F-4", finishing: "semi_finished" },
    { code: "F-5", finishing: "fully_finished" }
  ]);
  expect(mapFinishing("something odd")).toBeNull();
});

test("search: units with the exact finishing come first, then the ones with a blank finishing", async () => {
  const Search = require("../../services/search");
  const base = { broker_id: h.BROKERS.broker.id, property_type: "apartment" };
  await h.insertListing({ ...base, code: "S-BLANK", finishing: null });
  await h.insertListing({ ...base, code: "S-OTHER", finishing: "super_lux" });
  await h.insertListing({ ...base, code: "S-EXACT", finishing: "semi_finished" });
  const res = await Search.runSearch(h.pool, h.AGENCY_A, { filters: { property_types: ["apartment"], finishing: ["semi_finished"] } }, { pageSize: 10 });
  expect(res.rows.map((r) => r.code)).toEqual(["S-EXACT", "S-BLANK"]);
});
