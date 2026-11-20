"use strict";

// Compound phases (Madinaty B1…B15, El Rehab phases) as sub-zones: the migration data, the text rules, the unit box chips, the
// save, search scope and the import. The list is data/areas/compound-phases.json (a draft the owner will change), so these tests
// read the names from the database and not from the file.
const Phases = require("../../domain/phases");
const UnitBox = require("../../domain/unitBox");
const Q = require("../../domain/searchQuery");
const Suggest = require("../../services/placeSuggest");
const Resolve = require("../../services/compoundResolve");
const AreaSearch = require("../../services/areaSearch");
const Areas = require("../../services/areas");
const Search = require("../../services/search");
const { createTestDb } = require("../harness/db");

jest.setTimeout(60000);

describe("compound phases", () => {
  let db;
  let lists;
  let mad;
  const q = (sql, args) => db.pool.query(sql, args);
  const phaseId = async (en) => (await q("SELECT id FROM areas WHERE name_en = $1 AND place_type = 'phase'", [en])).rows[0]?.id;

  beforeAll(async () => {
    db = await createTestDb();
    Suggest.resetCache();
    lists = { places: (await q("SELECT id, name_en, name_ar, aliases, area_id, subzone_id FROM map_places WHERE approved")).rows, areas: await Areas.approvedAreas(db.pool) };
    mad = (await q("SELECT id FROM areas WHERE name_en = 'Madinaty' AND parent_id IS NULL")).rows[0].id;
  });
  afterAll(() => db.pool.end());

  test("the migration seeds B1 to B15 under Madinaty (existing rows reused) and phases under El Rehab", async () => {
    const kids = (await q("SELECT name_en FROM areas WHERE parent_id = $1 AND place_type = 'phase' ORDER BY name_en", [mad])).rows.map((r) => r.name_en);
    expect(kids).toHaveLength(26); // B1 2 3 6 7 8 10 11 12 14 15, VG1 to VG11, Golf Villas, Privado, Craft Zone, The Spine
    expect(kids).toEqual(expect.arrayContaining(["Madinaty B6", "Madinaty VG3", "Golf Villas", "Privado", "Craft Zone", "The Spine"]));
    for (const n of [4, 5, 9, 13]) expect(kids).not.toContain(`Madinaty B${n}`);
    expect(kids).not.toContain("Celia");
    expect((await q("SELECT count(*)::int AS n FROM areas WHERE name_en IN ('B6', 'Madinaty B6')")).rows[0].n).toBe(1); // renamed, not duplicated
    const reh = (await q("SELECT id FROM areas WHERE name_en = 'El Rehab'")).rows;
    expect(reh).toHaveLength(1);
    expect((await q("SELECT count(*)::int AS n FROM areas WHERE parent_id = $1 AND place_type = 'phase'", [reh[0].id])).rows[0].n).toBe(10);
    // Other children of Madinaty (VG, Privado) stay plain sub-zones.
    expect((await q("SELECT count(*)::int AS n FROM areas WHERE parent_id = $1 AND place_type IS DISTINCT FROM 'phase'", [mad])).rows[0].n).toBeGreaterThan(0);
  });

  test("the compounds stand on the phases' parent, so picking them offers the phases", async () => {
    const m = (await q("SELECT p.area_id FROM map_places p WHERE p.name_key = 'madinaty'")).rows[0];
    expect(m.area_id).toBe(mad);
    const r = (await q("SELECT p.subzone_id FROM map_places p WHERE p.name_key = 'el rehab'")).rows[0];
    expect(r.subzone_id).toBe((await q("SELECT id FROM areas WHERE name_en = 'El Rehab'")).rows[0].id);
  });

  test.each([
    ["مدينتي B6", "Madinaty B6"],
    ["b6 madinaty", "Madinaty B6"],
    ["B6 مدينتي", "Madinaty B6"],
    ["مدينتي بي 6", "Madinaty B6"],
    ["الرحاب مرحلة 7", "Rehab Phase 7"],
    ["rehab phase 7", "Rehab Phase 7"],
    ["الرحاب المرحلة السابعة", "Rehab Phase 7"],
    ["B6", "Madinaty B6"], // bare: a code of its own name, only Madinaty has it
    ["VG3", "Madinaty VG3"],
    ["مدينتي المرحلة السادسة", "Madinaty B6"],
    ["مدينتي سادسة", "Madinaty B6"],
    ["مدينتي ب6", "Madinaty B6"],
    ["The Spine", "The Spine"],
    ["rehab p7", "Rehab Phase 7"],
    ["الرحاب م7", "Rehab Phase 7"]
  ])("%s resolves to %s", async (text, en) => {
    const hit = Phases.findPhase(text, lists);
    expect(hit && hit.phase.id).toBe(await phaseId(en));
  });

  test("generic aliases never resolve on their own; B4 and B16 do not exist", () => {
    for (const t of ["مرحلة 7", "المرحلة السابعة", "phase 1", "stage 1", "المرحلة الأولى", "مرحلة 1", "سادسة", "م1", "p7", "B4", "B16", "مدينتي B4", "مدينتي", "الرحاب"]) {
      expect([t, Phases.findPhase(t, lists)]).toEqual([t, null]);
    }
    // With the parent named the same words resolve, and only that parent's phase.
    expect(Phases.findPhase("الرحاب مرحلة 7", lists).phase.name_en).toBe("Rehab Phase 7");
    expect(Phases.findPhase("مدينتي مرحلة 7", lists)).toBeNull();
    expect(Phases.findPhase("الرحاب المرحلة الأولى", lists).phase.name_en).toBe("Rehab Phase 1");
  });

  test("a pasted message keeps the compound and names the phase", async () => {
    const r = UnitBox.resolve("شقة للبيع في مدينتي B6 تشطيب سوبر لوكس", lists, "en");
    expect(r.place.kind).toBe("compound");
    expect(r.place.name_en).toBe("Madinaty");
    expect(r.phase.id).toBe(await phaseId("Madinaty B6"));
    expect(UnitBox.resolve("مدينتي", lists, "ar").phase).toBeNull();
  });

  test("the unit box returns phase chips for Madinaty and Rehab, in order, with the base to go back to", async () => {
    const items = await Suggest.box(db.pool, "madinaty", "en");
    const comp = items.find((i) => i.kind === "compound" && i.name_en === "Madinaty");
    expect(comp.phases).toHaveLength(26);
    expect(comp.phases[0].label).toBe("Madinaty B1");
    expect(comp.phases[3].label).toBe("Madinaty B6");
    expect(comp.phases[11].label).toBe("Madinaty VG1");
    expect(comp.phases[25].label).toBe("The Spine");
    expect(comp.phasesBase).toBe("");
    const rehab = (await Suggest.box(db.pool, "el rehab", "en")).find((i) => i.kind === "compound");
    expect(rehab.phases).toHaveLength(10);
    expect(rehab.phasesBase).toBe((await q("SELECT id FROM areas WHERE name_en = 'El Rehab'")).rows[0].id);
    const other = (await Suggest.box(db.pool, "hyde park", "en")).find((i) => i.kind === "compound");
    expect(other.phases).toBeUndefined();
  });

  test("an edited unit shows its phase as the chosen chip; the paste result carries the phase", async () => {
    const b6 = await phaseId("Madinaty B6");
    const chip = await Suggest.placeChip(db.pool, { compound: "Madinaty", area_id: mad, subzone_id: b6 }, "en");
    expect(chip.known).toBe(true);
    expect(chip.phases.find((p) => p.selected).id).toBe(b6);
    const pasted = await Suggest.boxResolve(db.pool, "b6 madinaty", "en");
    expect(pasted.phase.id).toBe(b6);
    expect(pasted.place.name_en).toBe("Madinaty");
    const { unitForm } = require("../../web/views/unitForm");
    const { formFromUnit } = require("../../web/forms/unitForm");
    const html = String(unitForm({ values: { ...formFromUnit({ market: "resale" }), compound: "Madinaty", area_id: mad, subzone_id: b6 }, areas: lists.areas, place: chip, lang: "en" }));
    expect(html).toMatch(/data-phase="[^"]+" aria-pressed="true">Madinaty B6/);
    expect(html).toMatch(/data-ubox-phases data-base=""(?! hidden)/);
  });

  test("saving keeps the compound and puts the phase in subzone_id; the text 'مدينتي B6' does the same", async () => {
    const b6 = await phaseId("Madinaty B6");
    const a = await Resolve.resolve(db.pool, { compound: "Madinaty", area_id: mad, subzone_id: b6 });
    expect(a.compound_state).toBeNull();
    expect(a.place_id).not.toBeNull();
    expect(a.subzone_id).toBe(b6);
    expect(a.area_id).toBe(mad);
    const b = await Resolve.resolve(db.pool, { compound: "مدينتي B6" });
    expect(b.place_id).toBe(a.place_id);
    expect(b.subzone_id).toBe(b6);
    // A sub-zone that is not a phase is still dropped under a compound with another sub-zone.
    const vg = (await q("SELECT id FROM areas WHERE parent_id = $1 AND place_type IS DISTINCT FROM 'phase' LIMIT 1", [mad])).rows[0].id;
    expect((await Resolve.resolve(db.pool, { compound: "Madinaty", area_id: mad, subzone_id: vg })).subzone_id).toBeNull();
  });

  test("Excel import: the location text 'مدينتي B6' resolves the phase through the same lookup", async () => {
    const b6 = await phaseId("Madinaty B6");
    const out = await Resolve.normalize(db.pool, { compound: "Madinaty B6" });
    expect(out.subzone_id).toBe(b6);
    expect(out.place_id).not.toBeNull();
    const bare = await Resolve.normalize(db.pool, { compound: "", district: "B6" });
    expect(bare.subzone_id).toBe(b6);
  });

  test("search: the compound includes every phase, the phase narrows", async () => {
    const b6 = await phaseId("Madinaty B6");
    const b7 = await phaseId("Madinaty B7");
    const comp = (await q("SELECT id FROM map_places WHERE name_key = 'madinaty'")).rows[0].id;
    const agency = (await q("INSERT INTO agencies (name) VALUES ('Phase Agency') RETURNING id")).rows[0].id;
    const broker = (await q("INSERT INTO brokers (agency_id, phone_number, name, role, is_active) VALUES ($1, '201000000501', 'PB', 'owner', true) RETURNING id", [agency])).rows[0].id;
    let n = 0;
    const unit = async (sub) => (await q(
      `INSERT INTO listings (agency_id, broker_id, code, listing_type, property_type, compound, place_id, area_id, subzone_id, price_value, status)
       VALUES ($1, $2, $3, 'sale', 'apartment', 'مدينتي', $4, $5, $6, 3000000, 'active') RETURNING id`, [agency, broker, `PH-${++n}`, comp, mad, sub])).rows[0].id;
    const u6 = await unit(b6);
    const u7 = await unit(b7);
    const u0 = await unit(null);
    const idsOf = async (text) => (await Search.runSearch(db.pool, agency, Q.fallbackParse(text), { pageSize: 50 })).ids;
    const all = await idsOf("مدينتي");
    expect([u6, u7, u0].every((id) => all.includes(id))).toBe(true);
    expect(await idsOf("مدينتي B6")).toEqual([u6]);
    expect(await idsOf("b7 madinaty")).toEqual([u7]);
    const scope = await AreaSearch.phaseScope(db.pool, "مدينتي B7");
    expect(scope.scope.subzones).toEqual([b7]);
  });

  test("search: Rehab 2 searches phases 6 to 10, Rehab 1 phases 1 to 5, a phase just itself", async () => {
    const reh = (await q("SELECT id, parent_id FROM areas WHERE name_en = 'El Rehab'")).rows[0];
    const comp = (await q("SELECT id FROM map_places WHERE name_key = 'el rehab'")).rows[0].id;
    const agency = (await q("INSERT INTO agencies (name) VALUES ('Rehab Agency') RETURNING id")).rows[0].id;
    const broker = (await q("INSERT INTO brokers (agency_id, phone_number, name, role, is_active) VALUES ($1, '201000000503', 'RB', 'owner', true) RETURNING id", [agency])).rows[0].id;
    const ids = {};
    for (const n of [1, 5, 6, 7, 10]) {
      const sub = await phaseId(`Rehab Phase ${n}`);
      ids[n] = (await q(
        `INSERT INTO listings (agency_id, broker_id, code, listing_type, property_type, compound, place_id, area_id, subzone_id, price_value, status)
         VALUES ($1, $2, $3, 'sale', 'apartment', 'الرحاب', $4, $5, $6, 3000000, 'active') RETURNING id`, [agency, broker, `RH-${n}`, comp, reh.parent_id, sub])).rows[0].id;
    }
    const idsOf = async (text) => (await Search.runSearch(db.pool, agency, Q.fallbackParse(text), { pageSize: 50 })).ids.sort();
    const set = (...ns) => ns.map((n) => ids[n]).sort();
    expect(await idsOf("Rehab 2")).toEqual(set(6, 7, 10));
    expect(await idsOf("امتداد الرحاب")).toEqual(set(6, 7, 10));
    expect(await idsOf("الرحاب 1")).toEqual(set(1, 5));
    expect(await idsOf("rehab phase 7")).toEqual(set(7));
    expect(await idsOf("الرحاب مرحلة 7")).toEqual(set(7));
  });

  test("map: a unit with a phase and no compound is drawn at the phase pin; one with a compound stays on the compound's pin", async () => {
    const MapPlaces = require("../../services/mapPlaces");
    const b6 = await phaseId("Madinaty B6");
    const comp = (await q("SELECT id FROM map_places WHERE name_key = 'madinaty'")).rows[0].id;
    const agency = (await q("INSERT INTO agencies (name) VALUES ('Map Phase Agency') RETURNING id")).rows[0].id;
    const broker = (await q("INSERT INTO brokers (agency_id, phone_number, name, role, is_active) VALUES ($1, '201000000502', 'MB', 'owner', true) RETURNING id, agency_id, role", [agency])).rows[0];
    const ins = (code, compound, place) => q(
      `INSERT INTO listings (agency_id, broker_id, code, listing_type, property_type, compound, place_id, area_id, subzone_id, price_value, status)
       VALUES ($1, $2, $3, 'sale', 'apartment', $4, $5, $6, $7, 2000000, 'active')`, [agency, broker.id, code, compound, place, mad, b6]);
    await ins("MP-1", null, null);
    await ins("MP-2", "Madinaty", comp);
    await MapPlaces.clearCache();
    const r = await MapPlaces.pins(db.pool, broker, {});
    const pin = r.pins.find((p) => p.id === b6);
    expect(pin.n).toBe(1);
    expect(pin.lat).toBeCloseTo(30.078579, 4);
    expect(r.pins.find((p) => p.id === comp).n).toBe(1);
    expect(r.unmapped).toBe(0);
    expect((await MapPlaces.unitsAt(db.pool, broker, b6)).map((u) => u.code)).toEqual(["MP-1"]);
    expect((await MapPlaces.place(db.pool, b6)).name_en).toBe("Madinaty B6");
  });
});
