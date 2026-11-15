// tests/web/catalogue-pages.test.js — The catalogue's new list (search box, chips, cards), the add/edit project form and its message reader.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Catalogue = require("../../services/catalogue");
const Suggest = require("../../services/placeSuggest");
const Paste = require("../fixtures/project-pastes");

jest.setTimeout(60000);

let h;
let admin;
let obour;
beforeEach(async () => {
  h = await createHarness();
  await h.query("INSERT INTO areas (name_key, name_en, name_ar, aliases) VALUES ('new obour city', 'New Obour City', 'العبور الجديدة', ARRAY['New Obour','نيو عبور']) ON CONFLICT DO NOTHING");
  Suggest.resetCache();
  obour = (await h.query("SELECT id FROM areas WHERE name_en = 'New Obour City'"))[0].id;
  admin = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];
});
afterAll(closeHarness);

test("the new-project form: required and optional marked, the paste box, the unit box, the developer list", async () => {
  const { agent } = await signIn(h, "admin");
  const res = await agent.get("/app/catalogue/projects/new");
  expect(res.status).toBe(200);
  expect(res.text).toContain('data-project-form');
  expect(res.text).toContain("data-ubox"); // place and features
  expect(res.text).toContain("data-devbox"); // developer: searchable list or a new one
  expect(res.text).toMatch(/name="paste_text"/);
  expect(res.text).toContain("Project name *");
  expect((res.text.match(/\(optional\)/g) || []).length).toBeGreaterThan(10);
  expect(res.text).toMatch(/\/app\/static\/projectForm\.[0-9a-f]*\.?js|projectForm/);
  // A broker (not a manager) cannot open it.
  const b = await signIn(h, "broker");
  expect((await b.agent.get("/app/catalogue/projects/new")).status).toBe(403);
});

test("the message reader answers with the project, developer, place, numbers (no AI, nothing saved)", async () => {
  const { agent, csrf } = await signIn(h, "admin");
  const res = await agent.post("/app/catalogue/projects/read").set("X-CSRF-Token", csrf).type("form").send({ text: Paste.ARABISK });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ name: "THE NEW BALANCE", developer: { name: "ARABISK DEVELOPMENT", new: true }, fields: { area_acres: 15, bedrooms: [2, 3, 4], price_from: 2000000 } });
  expect(res.body.place).toMatchObject({ kind: "area", id: obour });
  expect((await h.query("SELECT count(*)::int AS n FROM projects"))[0].n).toBe(0);
});

test("adding a project from the form saves the rows; a missing place is refused", async () => {
  const { agent, csrf } = await signIn(h, "admin");
  const post = (body) => agent.post("/app/catalogue/projects").set("X-CSRF-Token", csrf).type("form").send(body);
  const refused = await post({ name: "No Place", paste_text: "" });
  expect(refused.status).toBe(400);
  expect(refused.text).toMatch(/Pick the place/);
  const ok = await post({ name: "THE NEW BALANCE", paste_text: Paste.ARABISK, area_id: obour, compound: "", developer_name: "ARABISK DEVELOPMENT", price_from: "2,000,000", area_acres: "15", bedrooms: ["2", "3", "4"], feature: ["roof"], status: "launching" });
  expect(ok.status).toBe(303);
  const p = (await h.query("SELECT * FROM projects WHERE name = 'THE NEW BALANCE'"))[0];
  expect(p).toMatchObject({ developer_name: "ARABISK DEVELOPMENT", area_id: obour, status: "launching", district: "New Obour City" });
  expect(p.place_ids).toEqual([obour]);
  expect(p.feature_keys).toEqual(["roof"]);
  expect((await h.query("SELECT count(*)::int AS n FROM developers WHERE name = 'ARABISK DEVELOPMENT'"))[0].n).toBe(1);
  // The edit page shows what was saved (the place as a chip, the message again).
  const edit = await agent.get(`/app/catalogue/projects/${p.id}/edit`);
  expect(edit.status).toBe(200);
  expect(edit.text).toContain("New Obour City");
  expect(edit.text).toContain("ARABISK DEVELOPMENT");
  expect(edit.text).toContain("Feddan");
});

test("the list: cards, the place chip filter, the feature chip filter, the search box answers", async () => {
  const { agent } = await signIn(h, "admin");
  const dev = (await Catalogue.saveDeveloper(h.pool, admin, { name: "Arabisk" })).developer;
  await Catalogue.saveProject(h.pool, admin, { name: "Alpha Obour", developer_id: dev.id, area_id: obour, price_from: "2,000,000", feature: ["roof"], paste_text: "" });
  await Catalogue.saveProject(h.pool, admin, { name: "Beta Elsewhere", paste_text: "" });
  const all = (await agent.get("/app/catalogue")).text;
  expect(all).toContain("Alpha Obour");
  expect(all).toContain("Beta Elsewhere");
  expect(all).toContain("data-csearch");
  const byPlace = (await agent.get(`/app/catalogue?pl=${obour}`)).text;
  expect(byPlace).toContain("Alpha Obour");
  expect(byPlace).not.toContain("Beta Elsewhere");
  expect(byPlace).toContain("chip-place"); // the place chip, with its remove link
  expect((await agent.get("/app/catalogue?f=roof")).text).not.toContain("Beta Elsewhere");
  expect((await agent.get(`/app/catalogue?dev=${dev.id}`)).text).toContain("Alpha Obour");
  const box = await agent.get("/app/catalogue/search-box?q=obour");
  expect(box.body.items.map((i) => i.kind)).toEqual(expect.arrayContaining(["area", "project"]));
  // A broker searches too, but never sees the developer form.
  const b = await signIn(h, "broker");
  const bl = (await b.agent.get("/app/catalogue")).text;
  expect(bl).toContain("Alpha Obour");
  expect(bl).not.toContain("data-new-project");
});

test("the project page shows a carousel of the shared photos and the read details", async () => {
  const { agent } = await signIn(h, "admin");
  const p = (await Catalogue.saveProject(h.pool, admin, { name: "Photo Proj", area_id: obour, paste_text: Paste.PMC })).project;
  await h.query("INSERT INTO project_images (agency_id, project_id, url, mime, role, position) VALUES ($1, $2, 'https://img.example/1.jpg', 'image/jpeg', 'shared', 0), ($1, $2, 'https://img.example/2.jpg', 'image/jpeg', 'shared', 1)", [admin.agency_id, p.id]);
  const page = (await agent.get(`/app/catalogue/projects/${p.id}`)).text;
  expect(page).toContain('class="car"');
  expect(page).toContain("car-slide");
  expect(page).toContain("Archrete"); // a fact row read from the message
  expect(page).toContain("data-project-facts");
});
