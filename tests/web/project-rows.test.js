// tests/web/project-rows.test.js — A pasted launch message becomes rows: project columns, offers and facts, all searchable.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const Catalogue = require("../../services/catalogue");
const ProjectPaste = require("../../services/projectPaste");
const ProjectRows = require("../../services/projectRows");
const Suggest = require("../../services/placeSuggest");
const Paste = require("../../tests/fixtures/project-pastes");

jest.setTimeout(60000);

let h;
let admin;
beforeEach(async () => {
  h = await createHarness();
  await h.query("INSERT INTO areas (name_key, name_en, name_ar, aliases) VALUES ('obour city', 'Obour City', 'مدينة العبور', ARRAY['New Obour','العبور الجديدة']) ON CONFLICT DO NOTHING");
  await h.query("INSERT INTO areas (name_key, name_en, name_ar, parent_id) SELECT 'golden square', 'Golden Square', 'جولدن سكوير', id FROM areas WHERE name_en = 'New Cairo' ON CONFLICT DO NOTHING");
  admin = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];
  Suggest.resetCache();
});
afterAll(closeHarness);

const area = async (name) => (await h.query("SELECT id FROM areas WHERE name_en = $1 AND status = 'approved' ORDER BY parent_id NULLS LAST LIMIT 1", [name]))[0]?.id;

async function addFrom(text, extra = {}) {
  const read = await ProjectPaste.read(h.pool, admin, text, "en");
  const r = await Catalogue.saveProject(h.pool, admin, { ...ProjectPaste.formInput(text, read), ...extra });
  expect(r.error).toBeUndefined();
  return r.project;
}

describe("a pasted launch message", () => {
  test("a message with unit lines: the project, one offer row per unit, the numbers on the project", async () => {
    const p = await addFrom(Paste.JAZEEL);
    expect(p.name).toBe("JAZEEL RESIDENCE");
    expect(Number(p.price_from)).toBe(2862554);
    expect(Number(p.down_pct_min)).toBe(5);
    expect(Number(p.years_max)).toBe(9);
    expect(Number(p.discount_pct)).toBe(15);
    const offers = await h.query("SELECT area, floor, price, down, monthly, years, discount_pct, source FROM project_offers WHERE project_id = $1 ORDER BY area", [p.id]);
    expect(offers.map((o) => [Number(o.area), Number(o.price), o.source])).toEqual([[110, 2862554, "paste"], [146, 3724930, "paste"], [153, 3180590, "paste"]]);
    expect(Number(offers[2].monthly)).toBe(22087);
    expect(p.search_text).toContain("jazeel");
  });

  test("a launch with few facts: developer, acres, bedrooms, from-price; nothing invented", async () => {
    const read = await ProjectPaste.read(h.pool, admin, Paste.ARABISK, "en");
    expect(read.name).toBe("THE NEW BALANCE");
    expect(read.developer).toEqual({ name: "ARABISK DEVELOPMENT", new: true });
    expect(read.fields).toMatchObject({ area_acres: 15, bedrooms: [2, 3, 4], price_from: 2000000, status: "launching", down_pct_min: null, years_max: null });
    const p = await addFrom(Paste.ARABISK);
    expect(p.developer_name).toBe("ARABISK DEVELOPMENT");
    expect(p.bedroom_options).toEqual([2, 3, 4]);
    expect(Number(p.area_acres)).toBe(15);
  });

  test("a single office unit: one offer, other details as fact rows", async () => {
    const p = await addFrom(Paste.PMC);
    expect(p.name).toBe("PMC Mall");
    expect(p.property_types).toEqual(["office"]);
    expect(p.delivery_raw).toBe("استلام سنه واحدة فقط");
    const facts = await h.query("SELECT key, value FROM project_facts WHERE project_id = $1 ORDER BY key", [p.id]);
    expect(facts.map((f) => f.key)).toEqual(["consultant", "operator", "rental_mandate"]);
    const [offer] = await h.query("SELECT area, floor, price, property_type FROM project_offers WHERE project_id = $1", [p.id]);
    expect(offer).toMatchObject({ floor: "السابع", property_type: "office" });
    expect(Number(offer.price)).toBe(5875000);
  });

  test("saving again replaces the pasted rows (no duplicates) and keeps a developer once", async () => {
    const p = await addFrom(Paste.JAZEEL);
    await addFrom(Paste.JAZEEL, { id: p.id });
    expect((await h.query("SELECT count(*)::int AS n FROM project_offers WHERE project_id = $1", [p.id]))[0].n).toBe(3);
  });

  test("a message that is only a name is offered as the project name", async () => {
    const read = await ProjectPaste.read(h.pool, admin, Paste.NAME_ONLY, "en");
    expect(read.name).toBe("matter makers");
    expect(read.found).toEqual(["name"]);
  });
});

describe("searching projects by the rows", () => {
  test("place, features, developer, bedrooms, price and words each narrow the list", async () => {
    const obour = await area("Obour City");
    const cairo = await area("New Cairo");
    const dev = (await Catalogue.saveDeveloper(h.pool, admin, { name: "Arabisk" })).developer;
    const a = (await Catalogue.saveProject(h.pool, admin, { name: "Alpha", developer_id: dev.id, area_id: obour, price_from: "2,000,000", bedrooms: "2,3", feature: ["roof"], paste_text: "" })).project;
    await Catalogue.saveProject(h.pool, admin, { name: "Beta", area_id: cairo, price_from: "9,000,000", bedrooms: "4", paste_text: "" });
    await Catalogue.saveProject(h.pool, admin, { name: "Gamma", area_id: obour, price_from: "7,000,000", bedrooms: "3", paste_text: "" });
    const names = async (q) => (await Catalogue.listProjectsPage(h.pool, admin, q)).items.map((x) => x.name);
    expect(await names({})).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(await names({ place: obour })).toEqual(["Alpha", "Gamma"]);
    expect(await names({ place: obour, maxPrice: "3,000,000" })).toEqual(["Alpha"]);
    expect(await names({ bedrooms: 3 })).toEqual(["Alpha", "Gamma"]);
    expect(await names({ features: ["roof"] })).toEqual(["Alpha"]);
    expect(await names({ developer: dev.id })).toEqual(["Alpha"]);
    expect(await names({ q: "alpha" })).toEqual(["Alpha"]);
    expect(a.place_ids).toContain(obour);
  });

  test("a place chip finds the projects under its parents too (the area above a sub-area)", async () => {
    const sub = (await h.query("SELECT id, parent_id FROM areas WHERE name_en = 'Golden Square'"))[0];
    await Catalogue.saveProject(h.pool, admin, { name: "Deep", area_id: sub.parent_id, subzone_id: sub.id, paste_text: "" });
    expect((await Catalogue.listProjectsPage(h.pool, admin, { place: sub.parent_id })).items.map((x) => x.name)).toEqual(["Deep"]);
    expect((await Catalogue.listProjectsPage(h.pool, admin, { place: sub.id })).items.map((x) => x.name)).toEqual(["Deep"]);
  });

  test("an invalid number is refused with its field", async () => {
    expect(await Catalogue.saveProject(h.pool, admin, { name: "Bad", price_from: "abc" })).toMatchObject({ error: "invalid", field: "price_from" });
    expect(await Catalogue.saveProject(h.pool, admin, { name: "Bad", down_pct_min: "120" })).toMatchObject({ error: "invalid", field: "down_pct_min" });
    expect(ProjectRows.number("1,5", 100)).toBe(15);
  });
});

describe("global developer names, private developer rows", () => {
  test("the picker lists global names; choosing one makes the agency's own linked row, and nothing private is shared", async () => {
    const g = (await h.query("INSERT INTO global_developers (name) VALUES ('Zeta Developments') RETURNING id"))[0].id;
    const box = await ProjectPaste.developerBox(h.pool, admin, "zeta");
    expect(box).toEqual([expect.objectContaining({ global_id: g, name: "Zeta Developments" })]);
    const p = (await Catalogue.saveProject(h.pool, admin, { name: "P1", developer_global_id: g, paste_text: "" })).project;
    const dev = (await h.query("SELECT * FROM developers WHERE id = $1", [p.developer_id]))[0];
    expect(dev).toMatchObject({ name: "Zeta Developments", global_id: g, agency_id: admin.agency_id, contact_phone: null });
    // The agency's contact stays on its own row; the global row only has a name.
    await Catalogue.saveDeveloper(h.pool, admin, { id: dev.id, name: dev.name, contact_phone: "01099998888", notes: "secret" });
    expect(Object.keys((await h.query("SELECT * FROM global_developers WHERE id = $1", [g]))[0]).sort()).toEqual(["created_at", "id", "name", "name_en", "verified"]);
    // Now the agency has it: the picker shows the agency row, not a second global one.
    const again = await ProjectPaste.developerBox(h.pool, admin, "zeta");
    expect(again).toEqual([expect.objectContaining({ id: dev.id })]);
    // A message naming it finds the global name.
    await h.query("DELETE FROM projects");
    await h.query("DELETE FROM developers");
    const read = await ProjectPaste.read(h.pool, admin, "مشروع جديد من Zeta Developments في التجمع", "en");
    expect(read.developer).toMatchObject({ global_id: g, name: "Zeta Developments" });
  });
});

describe("a sub-area the list does not have", () => {
  test("the project is filed under the parent with its governorate; the new sub-area waits as pending, then the project moves under it when approved", async () => {
    await h.query("UPDATE areas SET governorate = 'Cairo' WHERE name_en = 'Obour City'");
    Suggest.resetCache();
    const obour = await area("Obour City");
    const r = await Catalogue.saveProject(h.pool, admin, { name: "Fresh", compound: "North Gate", compound_new: "1", area_id: obour, paste_text: "" });
    expect(r.project).toMatchObject({ area_id: obour, subzone_id: null, place_id: null, governorate: "Cairo" });
    const pending = (await h.query("SELECT id, status, parent_id FROM areas WHERE name_en = 'North Gate'"))[0];
    expect(pending).toMatchObject({ status: "pending", parent_id: obour });
    expect(r.project.pending_area_id).toBe(pending.id);
    expect(r.project.search_text).toContain("cairo");
    // Not in another agency's lists while pending, and the project is found by its parent area.
    expect((await Suggest.box(h.pool, "north gate", "en")).filter((x) => x.kind === "subzone")).toEqual([]);
    expect((await Catalogue.listProjectsPage(h.pool, admin, { place: obour })).items.map((x) => x.name)).toEqual(["Fresh"]);
    // The owner approves it: the project moves under the new sub-area.
    await require("../../services/placeReview").approveArea(h.pool, pending.id, {});
    const moved = (await h.query("SELECT subzone_id, pending_area_id, place_ids FROM projects WHERE name = 'Fresh'"))[0];
    expect(moved.subzone_id).toBe(pending.id);
    expect(moved.pending_area_id).toBeNull();
    expect(moved.place_ids).toEqual(expect.arrayContaining([pending.id, obour]));
  });

  test("the box for a project offers areas and sub-areas, never compounds; a message naming a compound gives its area", async () => {
    await h.query("UPDATE map_places SET approved = true, area_id = (SELECT id FROM areas WHERE name_en = 'New Cairo') WHERE name_key = 'hyde park'");
    Suggest.resetCache();
    expect((await Suggest.box(h.pool, "hyde", "en")).map((x) => x.kind)).toContain("compound");
    expect((await Suggest.box(h.pool, "hyde", "en", { areasOnly: true })).map((x) => x.kind)).not.toContain("compound");
    const read = await ProjectPaste.read(h.pool, admin, "مشروع جديد جنب Hyde Park في التجمع", "en");
    expect(read.place).toMatchObject({ kind: "area", label: "New Cairo" });
  });
});
