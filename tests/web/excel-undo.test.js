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
    expect(done.headers.location).toMatch(/\?undone=1#import-result$/);
    expect((await unit("VR2")).status).toBe("deleted");
    expect(Number((await unit("VR5")).price_value)).toBe(25000);
    // The first import's unit stays: only the last import is undone.
    expect((await unit("VR1")).status).toBe("active");
    expect((await agent.get(`${second.body.url}?undone=1`)).text).toMatch(/data-undone/);

    // Once undone, no second undo, and the earlier import is not offered either.
    expect((await agent.get(`${second.body.url}/undo`)).status).toBe(404);
    expect((await agent.post(`${second.body.url}/undo`).type("form").send({ _csrf: csrf })).status).toBe(404);
    // The earlier import is one of the last 10 applied within 30 days, so it can be undone too.
    expect((await agent.get(first.body.url)).text).toMatch(/data-undo-link/);
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

  test("an older import can be undone when nothing it wrote changed since", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const first = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", [unitRow(1, "VR")])] });
    await applyAll(agent, csrf, first.body.url);
    const second = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", [unitRow(2, "VR")])] });
    await applyAll(agent, csrf, second.body.url);
    const done = await agent.post(`${first.body.url}/undo`).type("form").send({ _csrf: csrf });
    expect(done.headers.location).toMatch(/\?undone=1#import-result$/);
    expect((await unit("VR1")).status).toBe("deleted");
    expect((await unit("VR2")).status).toBe("active");
  });

  test("an undo skips a unit edited by hand after the import, with the reason", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const first = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", [unitRow(5, "VR", "25k")])] });
    await applyAll(agent, csrf, first.body.url);
    const second = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", [unitRow(5, "VR", "30k")])] });
    await applyAll(agent, csrf, second.body.url);
    // A hand edit that does not bump the version: only the value check sees it.
    await h.query("UPDATE listings SET price_value = 40000 WHERE code_norm = 'VR5'");
    const confirm = await agent.get(`${second.body.url}/undo`);
    expect(confirm.text).toMatch(/VR5 \(اتعدلت بإيدك أو اتغيرت من تحميل تاني\)/);
    await agent.post(`${second.body.url}/undo`).type("form").send({ _csrf: csrf });
    expect(Number((await unit("VR5")).price_value)).toBe(40000);
  });

  test("an undo skips a unit changed by a later import", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const first = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", [unitRow(5, "VR", "25k")])] });
    await applyAll(agent, csrf, first.body.url);
    const second = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", [unitRow(5, "VR", "30k")])] });
    await applyAll(agent, csrf, second.body.url);
    const third = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", [unitRow(5, "VR", "35k")])] });
    await applyAll(agent, csrf, third.body.url);
    const confirm = await agent.get(`${second.body.url}/undo`);
    expect(confirm.text).toMatch(/data-undo-skipped/);
    expect(confirm.text).toMatch(/VR5 \(/);
    await agent.post(`${second.body.url}/undo`).type("form").send({ _csrf: csrf });
    expect(Number((await unit("VR5")).price_value)).toBe(35000);
  });

  test("an undo writes one operation log row", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const r = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", [unitRow(1, "VR")])] });
    await applyAll(agent, csrf, r.body.url);
    await agent.post(`${r.body.url}/undo`).type("form").send({ _csrf: csrf });
    const rows = await h.query("SELECT operation_type FROM operation_logs WHERE operation_type = 'excel_import_undo'");
    expect(rows).toHaveLength(1);
  });
});

describe("undo gives back the photos an import dropped", () => {
  const PHOTO = "https://x.test/old.jpg";
  // Sets up VR5 changed by the second import (30k), then marks the old photo as one that import dropped.
  async function setup() {
    const { agent, csrf } = await signIn(h, "manager");
    const first = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", [unitRow(5, "VR", "25k")])] });
    await applyAll(agent, csrf, first.body.url);
    const second = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", [unitRow(5, "VR", "30k")])] });
    await applyAll(agent, csrf, second.body.url);
    const importId = second.body.url.match(/[0-9a-f-]{36}/)[0];
    const listing = await unit("VR5");
    await h.query("UPDATE web_imports SET result = jsonb_set(result, '{undo,photos}', $2::jsonb) WHERE id = $1", [importId, JSON.stringify([{ id: listing.id, code: "VR5", added: [], dropped: [{ url: PHOTO, position: 0, role: null, phash: null }] }])]);
    const photos = () => h.query("SELECT url FROM listing_images WHERE listing_id = $1", [listing.id]);
    return { agent, csrf, url: second.body.url, listing, photos };
  }

  test("a unit that passes the version/after check gets its photo rows restored", async () => {
    const { agent, csrf, url, listing, photos } = await setup();
    expect(await photos()).toEqual([]);
    await agent.post(`${url}/undo`).type("form").send({ _csrf: csrf });
    expect(Number((await unit("VR5")).price_value)).toBe(25000);
    expect(await photos()).toEqual([{ url: PHOTO }]);
  });

  test("a unit skipped as changed keeps its photos untouched", async () => {
    const { agent, csrf, url, photos } = await setup();
    await h.query("UPDATE listings SET version = version + 1, price_value = 40000 WHERE code_norm = 'VR5'");
    await agent.post(`${url}/undo`).type("form").send({ _csrf: csrf });
    expect(Number((await unit("VR5")).price_value)).toBe(40000);
    expect(await photos()).toEqual([]);
  });
});
