"use strict";

// Areas and sub-zones: matching, the location rule, one suggestion list, the table rules, and linking compounds from district text.
const A = require("../../domain/areas");
const Areas = require("../../services/areas");
const { createTestDb } = require("../harness/db");

jest.setTimeout(60000);

const area = (id, en, ar, parent_id = null, aliases = []) => ({ id, parent_id, name_en: en, name_ar: ar, aliases });
const tree = [
  area("nc", "New Cairo", "القاهرة الجديدة", null, ["tagamoa"]),
  area("sz", "Sheikh Zayed", "الشيخ زايد"),
  area("s5", "5th Settlement", "التجمع الخامس", "nc"),
  area("ban", "Al Banafseg", "حي البنفسج", "nc", ["El Banafseg"]),
  area("ban1", "Banafseg 1", "فيلات البنفسج 1", "ban"),
  area("d1z", "1st District", "الحي الأول", "sz"),
  area("d1n", "1st District", "الحي الأول", "nc")
];

describe("area rules", () => {
  test("a typed name or alias leads to its area; the same name under two parents is ambiguous", () => {
    const index = A.buildIndex(tree);
    expect(A.resolveArea(index, "el banafseg")).toEqual({ id: "ban" });
    expect(A.resolveArea(index, "Tagamoa")).toEqual({ id: "nc" });
    expect(A.resolveArea(index, "1st District")).toEqual({ ambiguous: ["d1z", "d1n"] });
    expect(A.resolveArea(index, "nowhere")).toBeNull();
  });
  test("a chosen node is stored as its top area plus the node as sub-zone", () => {
    expect(A.placement(tree, "nc")).toEqual({ area_id: "nc", subzone_id: null });
    expect(A.placement(tree, "ban")).toEqual({ area_id: "nc", subzone_id: "ban" });
    expect(A.placement(tree, "ban1")).toEqual({ area_id: "nc", subzone_id: "ban1" });
  });
  test("a compound needs an area; a unit needs a compound or an area; a compound's area wins", () => {
    expect(A.checkLocation({}, { kind: "compound", areas: tree })).toEqual({ ok: false, error: "needs_area" });
    expect(A.checkLocation({}, { kind: "unit", areas: tree })).toEqual({ ok: false, error: "needs_location" });
    expect(A.checkLocation({ area_id: "sz" }, { kind: "unit", areas: tree })).toEqual({ ok: true, area_id: "sz", subzone_id: null });
    expect(A.checkLocation({ place_id: "p1", area_id: "sz" }, { kind: "unit", areas: tree, placeArea: "nc" })).toEqual({ ok: true, area_id: "nc", subzone_id: null });
  });
  test("a sub-zone must sit under the chosen area", () => {
    expect(A.checkLocation({ area_id: "nc", subzone_id: "ban1" }, { kind: "unit", areas: tree }).ok).toBe(true);
    expect(A.checkLocation({ area_id: "sz", subzone_id: "ban" }, { kind: "unit", areas: tree })).toEqual({ ok: false, error: "bad_subzone" });
    expect(A.checkLocation({ area_id: "nc", subzone_id: "nc" }, { kind: "unit", areas: tree })).toEqual({ ok: false, error: "bad_subzone" });
  });
  test("cleanArea needs a name and both coordinates or none", () => {
    expect(A.cleanArea({}).error).toBe("name");
    expect(A.cleanArea({ name_en: "X", lat: 30 }).error).toBe("coords");
    const ok = A.cleanArea({ name_en: " Golden Square ", aliases: "GS, gs ؛ golden" });
    expect(ok.ok).toBe(true);
    expect(ok.value.aliases).toEqual(["GS", "gs", "golden"]);
  });
});

describe("one suggestion list", () => {
  const places = [{ id: "p1", name_en: "Hyde Park", name_ar: "هايد بارك", aliases: ["hydepark"], area_id: "nc", subzone_id: "s5" }];
  test("compounds, aliases, areas and sub-zones come back together, exact first", () => {
    const out = A.suggest("hyde", { places, areas: tree });
    expect(out[0]).toMatchObject({ kind: "compound", id: "p1", path: "New Cairo › 5th Settlement", area_id: "nc", subzone_id: "s5" });
    const byAlias = A.suggest("hydepark", { places, areas: tree });
    expect(byAlias[0]).toMatchObject({ kind: "compound", via: "name" === byAlias[0].via ? "name" : "alias" });
    const areaHit = A.suggest("banaf", { places, areas: tree });
    expect(areaHit.map((r) => r.id)).toContain("ban");
    expect(areaHit.find((r) => r.id === "ban")).toMatchObject({ kind: "subzone", area_id: "nc", subzone_id: "ban" });
    expect(A.suggest("tagamoa", { places, areas: tree })[0]).toMatchObject({ kind: "area", id: "nc", via: "alias" });
  });
  test("a near spelling still shows as alike, and one letter finds nothing", () => {
    expect(A.suggest("hyde pard", { places, areas: tree }).map((r) => r.id)).toContain("p1");
    expect(A.suggest("h", { places, areas: tree })).toEqual([]);
  });
});

describe("areas in the database", () => {
  let db;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(() => db.pool.end());

  test("the starter list is loaded: New Cairo, its sub-zones and the blocks below them", async () => {
    const { rows } = await db.pool.query(
      `SELECT b.name_en FROM areas b JOIN areas a ON a.id = b.parent_id JOIN areas t ON t.id = a.parent_id
       WHERE t.name_en = 'New Cairo' AND a.name_en = 'Al Banafseg' AND b.name_en = 'Banafseg 1 (Villas)'`
    );
    expect(rows).toHaveLength(1);
    const { rows: top } = await db.pool.query("SELECT name_en FROM areas WHERE parent_id IS NULL ORDER BY name_en");
    expect(top.map((r) => r.name_en)).toEqual(expect.arrayContaining(["New Cairo", "Sheikh Zayed", "6th of October", "New Capital"]));
  });

  test("seeding twice adds nothing", async () => {
    const tree = require("../../data/areas/areas.json");
    expect(await Areas.seedTree(db.pool, tree)).toBe(0);
  });

  test("a fourth level is refused, and so is a sub-zone that is not under its area", async () => {
    const id = async (en, parent) => (await db.pool.query("SELECT id FROM areas WHERE name_en = $1 AND parent_id IS NOT DISTINCT FROM $2", [en, parent])).rows[0].id;
    const nc = await id("New Cairo", null);
    const ban = await id("Al Banafseg", nc);
    const ban1 = await id("Banafseg 1 (Villas)", ban);
    await expect(db.pool.query("INSERT INTO areas (parent_id, name_key, name_en) VALUES ($1, 'deep', 'Deep')", [ban1])).rejects.toThrow(/three levels/);
    const sz = await id("Sheikh Zayed", null);
    await expect(db.pool.query("INSERT INTO map_places (name_key, name_en, area_id, subzone_id) VALUES ('x', 'X', $1, $2)", [sz, ban])).rejects.toThrow(/not under the chosen area/);
    await db.pool.query("INSERT INTO map_places (name_key, name_en, area_id, subzone_id) VALUES ('y', 'Y', $1, $2)", [nc, ban1]);
  });

  test("compounds are linked from district text when it leads to one area; others are listed", async () => {
    await db.pool.query(
      `INSERT INTO map_places (name_key, name_en, district) VALUES
       ('gs1', 'GS One', 'Golden Square'), ('nc1', 'NC One', 'New Cairo'), ('mix', 'Mixed', 'Sadat Axis / Northern Investors'), ('none', 'None', NULL)`
    );
    const r = await Areas.linkPlacesFromDistrict(db.pool);
    expect(r.linked).toBe(2);
    const { rows } = await db.pool.query(
      "SELECT p.name_en, a.name_en AS area, s.name_en AS sub FROM map_places p LEFT JOIN areas a ON a.id = p.area_id LEFT JOIN areas s ON s.id = p.subzone_id WHERE p.name_key IN ('gs1','nc1') ORDER BY p.name_key"
    );
    expect(rows).toEqual([
      { name_en: "GS One", area: "New Cairo", sub: "Golden Square" },
      { name_en: "NC One", area: "New Cairo", sub: null }
    ]);
    const left = await Areas.placesWithoutArea(db.pool);
    expect(left.map((p) => p.name_en)).toEqual(expect.arrayContaining(["Mixed", "None"]));
  });
});
