// tests/web/seed-projects.test.js — The catalogue test data: 20 projects, 10 in one area, and the search over them.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const Catalogue = require("../../services/catalogue");
const Suggest = require("../../services/placeSuggest");
const { seedProjects } = require("../../scripts/seed-projects");

jest.setTimeout(90000);

let h;
let admin;
const id = async (en) => (await h.query("SELECT id FROM areas WHERE name_en = $1", [en]))[0].id;
beforeEach(async () => {
  h = await createHarness();
  const top = (key, en, ar) => h.query("INSERT INTO areas (name_key, name_en, name_ar) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [key, en, ar]);
  const sub = (key, en, ar, parent) => h.query("INSERT INTO areas (name_key, name_en, name_ar, parent_id) SELECT $1, $2, $3, id FROM areas WHERE name_en = $4 ON CONFLICT DO NOTHING", [key, en, ar, parent]);
  await top("obour city", "Obour City", "مدينة العبور");
  await sub("new obour", "New Obour", "العبور الجديدة", "Obour City");
  await top("new capital", "New Capital", "العاصمة الإدارية الجديدة");
  await sub("mu23", "MU23", "منطقة MU23", "New Capital");
  await top("sheikh zayed", "Sheikh Zayed", "الشيخ زايد");
  await top("6th of october", "6th of October", "السادس من أكتوبر");
  await sub("5th settlement", "5th Settlement", "التجمع الخامس", "New Cairo");
  await sub("golden square", "Golden Square", "المربع الذهبي", "New Cairo");
  Suggest.resetCache();
  admin = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];
});
afterAll(closeHarness);

test("20 projects are added, 10 or more in New Obour, and run again they are replaced, not doubled", async () => {
  const first = await seedProjects(h.pool, admin.agency_id);
  expect(first).toHaveLength(20);
  expect((await h.query("SELECT count(*)::int AS n FROM projects"))[0].n).toBe(20);
  await seedProjects(h.pool, admin.agency_id);
  expect((await h.query("SELECT count(*)::int AS n FROM projects"))[0].n).toBe(20);
  const obour = await id("New Obour");
  const inObour = await Catalogue.listProjectsPage(h.pool, admin, { place: obour });
  expect(inObour.total).toBe(10);
  // The parent area finds the same ten (a sub-area is inside its city).
  expect((await Catalogue.listProjectsPage(h.pool, admin, { place: await id("Obour City") })).total).toBe(10);
  // Every project has a place and the three real samples were read: their offers are rows.
  expect((await h.query("SELECT count(*)::int AS n FROM projects WHERE cardinality(place_ids) = 0"))[0].n).toBe(0);
  expect((await h.query("SELECT count(*)::int AS n FROM project_offers WHERE source = 'paste'"))[0].n).toBeGreaterThanOrEqual(4);
  // Same place, different details: the filters tell them apart.
  const names = async (q) => (await Catalogue.listProjectsPage(h.pool, admin, { place: obour, ...q })).items.map((x) => x.name).sort();
  expect(await names({ maxPrice: "2,500,000" })).toEqual(["OBOUR HEIGHTS", "THE NEW BALANCE"]);
  expect(await names({ bedrooms: 5 })).toEqual(["LAGOON VIEW OBOUR", "OBOUR VILLAS"]);
  expect(await names({ features: ["roof"] })).toEqual(["SKYLINE OBOUR"]);
  expect((await names({ features: ["view_lagoon"] })).sort()).toEqual(["LAGOON VIEW OBOUR", "ZEN OBOUR"]);
  expect(await names({ q: "orient" })).toEqual(["OBOUR VILLAS", "PALMA GATE", "ZEN OBOUR"]);
  const dev = (await h.query("SELECT id FROM developers WHERE name = 'ORIENT DEVELOPMENT'"))[0].id;
  expect(await names({ developer: dev })).toEqual(["OBOUR VILLAS", "PALMA GATE", "ZEN OBOUR"]);
  // No place filter: all 20; a different place: its own.
  expect((await Catalogue.listProjectsPage(h.pool, admin, {})).total).toBe(20);
  expect((await Catalogue.listProjectsPage(h.pool, admin, { place: await id("New Cairo") })).total).toBe(3);
});
