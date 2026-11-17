// tests/web/import-word-fields.test.js — QA round 2 (item 28): an unknown word in the Excel type column is not always a
// compound or a unit type. The review panel offers a field dropdown and a value; the field is pre-picked from a suggestion; a
// compound is searched in the list.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Imports = require("../../services/imports");

jest.setTimeout(120000);

let h;
beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("manager");
});
afterAll(closeHarness);

const HEAD = ["name", "number", "unit type", "location", "price", "details", "area", "descibation", "code"];
const tab = (name, rows) => ({ name, rows: [{ n: 1, v: HEAD }, ...rows.map((v, i) => ({ n: i + 2, v })) ] });
const row = (i, type) => [`owner ${i}`, 1000000000 + i, type, `building ${i}`, "25k", "3 bedrooms / 2 bathrooms", `${100 + i}m`, "x", `WF${i}`];
const post = (agent, csrf, body) => agent.post("/app/import/excel/grid").set("X-CSRF-Token", csrf).send(body);
const planOf = async (id) => (await h.query("SELECT payload FROM web_imports WHERE id = $1", [id]))[0].payload;

describe("pure helpers", () => {
  test("a choice is a field and a value; bad values are refused", () => {
    expect(Imports.parseWordChoice("floor:3")).toEqual({ field: "floor", payload: "3" });
    expect(Imports.parseWordChoice("finishing:super_lux")).toEqual({ field: "finishing", payload: "super_lux" });
    expect(Imports.parseWordChoice("compound:Mivida")).toEqual({ field: "compound", payload: "Mivida" });
    expect(Imports.parseWordChoice("villa")).toEqual({ field: "type", payload: "villa" });
    expect(Imports.parseWordChoice("notes")).toEqual({ field: "notes", payload: "" });
    expect(Imports.parseWordChoice("finishing:bogus")).toBe(null);
    expect(Imports.parseWordChoice("hack:1")).toBe(null);
    expect(Imports.parseWordChoice("")).toBe(null);
  });

  test("the suggestion pre-picks the field", () => {
    expect(Imports.suggestWordField("3rd floor corner")).toEqual({ field: "floor", payload: "3" });
    expect(Imports.suggestWordField("super lux")).toMatchObject({ field: "finishing" });
    expect(Imports.suggestWordField("مفروش")).toMatchObject({ field: "furnishing" });
    expect(Imports.suggestWordField("byshtabha")).toEqual({ field: "notes", payload: "" });
    expect(Imports.suggestWordField("anything", "Hyde Park")).toEqual({ field: "compound", payload: "Hyde Park" });
  });
});

describe("the panel and the apply", () => {
  test("each unknown word shows a field dropdown, the value controls and the compound search", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const r = await post(agent, csrf, { filename: "SALE.xlsx", tabs: [tab("Villette", [row(1, "3rd floor corner"), row(2, "byshtabha")])] });
    const page = await agent.get(r.body.url);
    expect(page.text).toMatch(/data-word-form/);
    expect(page.text).toMatch(/name="field"/);
    expect(page.text).toMatch(/data-word-val="compound"[^]*?data-place-search/);
    expect(page.text).toMatch(/data-word-val="floor"/);
    // "3rd floor corner" is pre-picked as a floor.
    expect(page.text).toMatch(/data-type-word="3rd floor corner"[^]*?<option value="floor" selected>/);
    expect(page.text).toMatch(/wordfields\.js/);
  });

  test("a word can go to the floor, to finishing, to a compound picked from the list, or to the notes", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const r = await post(agent, csrf, { filename: "SALE.xlsx", tabs: [tab("Villette", [row(1, "3rd floor corner"), row(2, "super lux"), row(3, "mivida place"), row(4, "byshtabha")])] });
    const send = (from, form) => agent.post(`${r.body.url}/batch`).type("form").send({ _csrf: csrf, action: "type_map", from, ...form });
    await send("3rd floor corner", { field: "floor", v_floor: "3" });
    await send("super lux", { field: "finishing", v_finishing: "super_lux" });
    await send("mivida place", { field: "compound", v_compound: "Mivida" });
    await send("byshtabha", { field: "notes" });
    const rows = (await planOf(r.body.url.split("/").pop())).rows;
    const cell = (n) => rows.find((x) => x.rowNumber === n).cells;
    expect(cell(1)).toMatchObject({ floor: "3" });
    expect(cell(1).property_type).toBeUndefined();
    expect(cell(2)).toMatchObject({ finishing: "super_lux" });
    expect(cell(3).compound).toBe("Mivida");
    expect(cell(4).notes).toMatch(/byshtabha/);
    expect(cell(4).property_type).toBeUndefined();
  });

  test("a value that is not valid for its field changes nothing", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const r = await post(agent, csrf, { filename: "SALE.xlsx", tabs: [tab("Villette", [row(1, "weird word")])] });
    await agent.post(`${r.body.url}/batch`).type("form").send({ _csrf: csrf, action: "type_map", from: "weird word", field: "finishing", v_finishing: "bogus" });
    const rows = (await planOf(r.body.url.split("/").pop())).rows;
    expect(rows[0].cells.property_type).toBe("weird word");
  });
});
