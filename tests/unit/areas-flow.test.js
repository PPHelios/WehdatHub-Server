"use strict";

// The area rules in the flows: a unit's area from its compound, an area typed as the compound, district text, the held-back
// rule, search by area, the location rule in the field table, and the suggestion list.
const Resolve = require("../../services/compoundResolve");
const Suggest = require("../../services/placeSuggest");
const AreaSearch = require("../../services/areaSearch");
const Vis = require("../../lib/visibility");
const Rules = require("../../domain/fieldRules");
const { buildSearchQuery } = require("../../services/search");
const { createTestDb } = require("../harness/db");

jest.setTimeout(60000);

describe("area rules in the flows", () => {
  let db;
  let nc;
  let ban;
  let place;
  let agency;
  let brokerA;
  let brokerB;
  let owner;
  beforeAll(async () => {
    db = await createTestDb();
    const q = (sql, args) => db.pool.query(sql, args);
    nc = (await q("SELECT id FROM areas WHERE name_en = 'New Cairo' AND parent_id IS NULL")).rows[0].id;
    ban = (await q("SELECT id FROM areas WHERE name_en = 'Al Banafseg'")).rows[0].id;
    place = (await q(
      "INSERT INTO map_places (name_key, name_en, name_ar, aliases, approved, area_id, subzone_id) VALUES ('banafseg heights', 'Banafseg Heights', 'ارتفاعات البنفسج', '{}', true, $1, $2) RETURNING id", [nc, ban]
    )).rows[0].id;
    agency = (await q("INSERT INTO agencies (name) VALUES ('Flow Agency') RETURNING id")).rows[0].id;
    const mk = async (phone, role) => (await q("INSERT INTO brokers (agency_id, phone_number, name, role, is_active) VALUES ($1, $2, $2, $3, true) RETURNING id, agency_id, role", [agency, phone, role])).rows[0];
    brokerA = await mk("201000000091", "broker");
    brokerB = await mk("201000000092", "broker");
    owner = await mk("201000000093", "owner");
  });
  afterAll(() => db.pool.end());

  test("a unit takes its compound's area and sub-zone", async () => {
    const f = await Resolve.normalize(db.pool, { compound: "Banafseg Heights", listing_type: "sale" });
    expect(f).toMatchObject({ place_id: place, compound_state: null, area_id: nc, subzone_id: ban });
  });

  test("a place typed as the compound that is really an area sets the area, with no pending compound", async () => {
    const f = await Resolve.normalize(db.pool, { compound: "Al Banafseg" });
    expect(f).toMatchObject({ compound_state: null, compound: null, area_id: nc, subzone_id: ban });
  });

  test("district text names the area; an unknown compound is held back but keeps a picked area", async () => {
    expect(await Resolve.normalize(db.pool, { district: "Golden Square", city: "Cairo" })).toMatchObject({ area_id: nc });
    const f = await Resolve.normalize(db.pool, { compound: "Nobody Knows Hills", area_id: nc }, {});
    expect(f).toMatchObject({ compound_state: "needs_fix", area_id: nc });
  });

  test("an edit that names no area keeps the unit's area", async () => {
    const f = await Resolve.normalize(db.pool, { compound_en: "Nobody Else Hills", compound: "Nobody Else Hills" });
    expect("area_id" in f).toBe(false);
  });

  test("the field table accepts a compound or an area and blocks a unit with neither", () => {
    const base = { listing_type: "sale", property_type: "apartment", price_value: 1, area_value: 100, bedrooms: 2 };
    const blockers = (l) => Rules.evaluate({ ...base, ...l }, { lang: "en", photoCount: 3 }).blockers.map((b) => b.key || b);
    expect(JSON.stringify(blockers({}))).toMatch(/location/);
    expect(JSON.stringify(blockers({ area_id: nc }))).not.toMatch(/location/);
    expect(JSON.stringify(blockers({ compound: "X" }))).not.toMatch(/location/);
  });

  test("a unit whose compound waits for approval is seen only by its broker and the agency owner", async () => {
    const q = (sql, args) => db.pool.query(sql, args);
    await q(
      "INSERT INTO listings (agency_id, broker_id, code, property_type, listing_type, status, compound, compound_state) VALUES ($1, $2, 'HB-1', 'apartment', 'sale', 'active', 'Pending Hills', 'needs_fix'), ($1, $2, 'HB-2', 'apartment', 'sale', 'active', 'Fine', NULL)",
      [agency, brokerA.id]
    );
    const codes = async (viewer) => (await Vis.run(viewer, () => q(`SELECT code FROM listings l WHERE l.agency_id = $1 AND ${Vis.units("l")} ORDER BY code`, [agency]))).rows.map((r) => r.code);
    expect(await codes(brokerA)).toEqual(["HB-1", "HB-2"]);
    expect(await codes(brokerB)).toEqual(["HB-2"]);
    expect(await codes(owner)).toEqual(["HB-1", "HB-2"]);
    expect((await q(`SELECT code FROM listings l WHERE l.agency_id = $1 AND ${Vis.units("l")}`, [agency])).rows.map((r) => r.code)).toEqual(["HB-2"]);
  });

  test("a search word that names a sub-zone finds units by their area columns", async () => {
    const q = (sql, args) => db.pool.query(sql, args);
    await q("INSERT INTO listings (agency_id, broker_id, code, property_type, listing_type, status, area_id, subzone_id) VALUES ($1, $2, 'AR-1', 'apartment', 'sale', 'active', $3, $4), ($1, $2, 'AR-2', 'apartment', 'sale', 'active', $3, NULL)", [agency, brokerA.id, nc, ban]);
    const { scope, rest } = await AreaSearch.scope(db.pool, ["al banafseg", "unknown word"]);
    expect(rest).toEqual(["unknown word"]);
    const { sql, params } = buildSearchQuery(agency, { filters: { area_scope: scope } }, { fx: {} });
    const rows = (await Vis.run(owner, () => q(sql, params))).rows.map((r) => r.code);
    expect(rows).toEqual(["AR-1"]);
    const top = await AreaSearch.scope(db.pool, ["new cairo"]);
    const all = buildSearchQuery(agency, { filters: { area_scope: top.scope } }, { fx: {} });
    expect((await Vis.run(owner, () => q(all.sql, all.params))).rows.map((r) => r.code).sort()).toEqual(["AR-1", "AR-2"]);
  });

  test("one suggestion list covers compounds, their aliases, areas and sub-zones", async () => {
    Suggest.resetCache();
    const byCompound = await Suggest.suggest(db.pool, "banafseg her");
    expect(byCompound[0]).toMatchObject({ kind: "compound", name_en: "Banafseg Heights", path: "New Cairo › Al Banafseg" });
    const byArea = await Suggest.suggest(db.pool, "banaf");
    expect(byArea.map((r) => r.kind)).toEqual(expect.arrayContaining(["subzone", "compound"]));
    expect(await Suggest.suggest(db.pool, "x")).toEqual([]);
  });
});
