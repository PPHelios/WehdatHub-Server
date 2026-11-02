// tests/web/excel-undo.test.js — Undo for the last applied Excel import: archive what it added, put back what it changed,
// leave alone what changed since, and never touch an earlier import.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");

jest.setTimeout(120000);

let h;
beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("manager");
});
afterAll(closeHarness);

const HEAD = ["name", "number", "unit type", "location", "price", "details", "area", "descibation", "code"];
const tab = (name, rows) => ({ name, rows: [{ n: 1, v: HEAD }, ...rows.map((v, i) => ({ n: i + 2, v }))] });
const unitRow = (i, prefix, price = "25k") => [`owner ${String.fromCharCode(97 + (i % 26))}`, 1000000000 + i, "apartment", `building ${i}`, price, "3 bedrooms / 2 bathrooms", `${100 + i}m`, "fully finished", `${prefix}${i}`];
const post = (agent, csrf, body) => agent.post("/app/import/excel/grid").set("X-CSRF-Token", csrf).send(body);
const unit = async (code) => (await h.query("SELECT * FROM listings WHERE code_norm = upper($1)", [code]))[0];
const applyAll = (agent, csrf, url) => agent.post(`${url}/apply`).type("form").send({ _csrf: csrf, all: "1" });

describe("undo the last applied Excel import", () => {
  test("archives what it added and puts back the price it changed; an earlier import is not undoable", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const first = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", [unitRow(1, "VR"), unitRow(5, "VR", "25k")])] });
    await applyAll(agent, csrf, first.body.url);
    const second = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", [unitRow(2, "VR"), unitRow(5, "VR", "30k")])] });
    expect((await agent.get(second.body.url)).text).not.toMatch(/data-undo-link/); // not applied yet
    await applyAll(agent, csrf, second.body.url);
    expect(Number((await unit("VR5")).price_value)).toBe(30000);

    const page = await agent.get(second.body.url);
    expect(page.text).toMatch(/data-undo-link/);
    const confirm = await agent.get(`${second.body.url}/undo`);
    expect(confirm.text).toMatch(/data-undo-confirm/);
    expect(confirm.text).toMatch(/data-undo-archive/);
    expect(confirm.text).toMatch(/data-undo-restore/);

    const done = await agent.post(`${second.body.url}/undo`).type("form").send({ _csrf: csrf });
    expect(done.headers.location).toMatch(/\?undone=1$/);
    expect((await unit("VR2")).status).toBe("archived");
    expect(Number((await unit("VR5")).price_value)).toBe(25000);
    // The first import's unit stays: only the last import is undone.
    expect((await unit("VR1")).status).toBe("active");
    expect((await agent.get(`${second.body.url}?undone=1`)).text).toMatch(/data-undone/);

    // Once undone, no second undo, and the earlier import is not offered either.
    expect((await agent.get(`${second.body.url}/undo`)).status).toBe(404);
    expect((await agent.post(`${second.body.url}/undo`).type("form").send({ _csrf: csrf })).status).toBe(404);
    expect((await agent.get(first.body.url)).text).not.toMatch(/data-undo-link/);
  });

  test("a unit changed since the import is left alone and listed, not overwritten", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const first = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", [unitRow(5, "VR", "25k")])] });
    await applyAll(agent, csrf, first.body.url);
    const second = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", [unitRow(5, "VR", "30k")])] });
    await applyAll(agent, csrf, second.body.url);
    await h.query("UPDATE listings SET version = version + 1, price_value = 40000 WHERE code_norm = 'VR5'");
    const confirm = await agent.get(`${second.body.url}/undo`);
    expect(confirm.text).toMatch(/data-undo-skipped/);
    await agent.post(`${second.body.url}/undo`).type("form").send({ _csrf: csrf });
    expect(Number((await unit("VR5")).price_value)).toBe(40000);
  });

  test("the undo link shows on the last applied import and its confirm page opens", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const r = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", [unitRow(1, "VR")])] });
    await applyAll(agent, csrf, r.body.url);
    expect((await agent.get(r.body.url)).text).toMatch(/data-undo-link/);
    expect((await agent.get(`${r.body.url}/undo`)).status).toBe(200);
  });
});
