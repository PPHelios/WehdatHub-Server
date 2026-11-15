"use strict";

// Migration 115: the v6 location list loads: compounds move to their sub-area, zones link compounds to the areas they are
// also in, bad and cross-compound aliases go, the investors extensions stay merged, a second run changes nothing.
const { createTestDb } = require("../harness/db");
const { up } = require("../../db/migrations/115_location_v6");
const data = require("../../db/data/location-v6-2026-11-15.json");

jest.setTimeout(120000);

describe("location v6", () => {
  let db;
  const q = (sql, args) => db.pool.query(sql, args);
  const place = async (name) => (await q("SELECT * FROM map_places WHERE name_en = $1", [name])).rows[0];
  const pathOf = async (id) => {
    const names = [];
    for (let cur = id; cur; ) {
      const a = (await q("SELECT name_en, parent_id FROM areas WHERE id = $1", [cur])).rows[0];
      names.unshift(a.name_en);
      cur = a.parent_id;
    }
    return names.join(" > ");
  };
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(() => db.pool.end());

  test("compounds sit in their v6 sub-area", async () => {
    const green = await place("Green Square");
    expect(await pathOf(green.subzone_id)).toBe("Mostakbal City > First Phase Mostakbal");
    const golf = await place("Golf View New Cairo");
    expect(await pathOf(golf.subzone_id)).toBe("New Cairo > Al Andalus > Andalus 1");
  });

  test("tags become zones: Golden Square finds compounds filed elsewhere", async () => {
    const { rows } = await q(
      `SELECT p.name_en FROM place_zones z JOIN map_places p ON p.id = z.place_id JOIN areas a ON a.id = z.area_id
        WHERE a.name_en = 'Golden Square'`
    );
    // 18 of the 24 tagged compounds are filed in the Golden Square sub-area itself; the other 6 are linked to it.
    expect(rows).toHaveLength(6);
    const auc = (await q("SELECT p.name_en AS parent FROM areas a JOIN areas p ON p.id = a.parent_id WHERE a.name_en = 'AUC Area'")).rows;
    expect(auc.map((r) => r.parent)).toEqual(["New Cairo"]);
    const links = (await q("SELECT count(*)::int AS n FROM place_zones")).rows[0].n;
    expect(links).toBe(data.compounds.reduce((n, c) => n + c.zones.length, 0));
  });

  test("bad and cross-compound aliases are gone; investors extensions stay merged; MU23 has one home", async () => {
    const bosco = await place("IL Bosco City");
    expect(bosco.aliases.join("|")).not.toMatch(/لاميرادا/);
    const tower = await place("Double Two Tower");
    expect(tower.aliases.join("|")).not.toMatch(/\p{Script=Hangul}/u);
    const ext = (await q("SELECT count(*)::int AS n FROM areas WHERE name_en ILIKE '%Investors Extension'")).rows[0].n;
    expect(ext).toBe(0);
    const mu23 = (await q("SELECT a.id FROM areas a WHERE a.name_en = 'MU23'")).rows;
    expect(mu23).toHaveLength(1);
    expect(await pathOf(mu23[0].id)).toBe("New Capital > MU23");
  });

  test("the four trap pins are replaced", async () => {
    const nc = (await q("SELECT lat, lng FROM areas WHERE name_en = 'New Cairo' AND parent_id IS NULL")).rows[0];
    expect([nc.lat, nc.lng]).toEqual([30.0285, 31.491]);
  });

  test("a second run changes nothing", async () => {
    const count = async () =>
      (await q("SELECT (SELECT count(*) FROM areas)::int AS a, (SELECT count(*) FROM map_places)::int AS p, (SELECT count(*) FROM place_zones)::int AS z")).rows[0];
    const before = await count();
    const client = await db.pool.connect();
    await client.query("BEGIN");
    await up(client);
    await client.query("COMMIT");
    client.release();
    expect(await count()).toEqual(before);
  });
});
