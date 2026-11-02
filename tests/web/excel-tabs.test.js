// tests/web/excel-tabs.test.js — The Excel import with tabs read in the browser: the grid endpoint, one batch change for many rows,
// the edit form that offers what is missing, paging for big files, apply all.
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

describe("grid endpoint", () => {
  test("every tab becomes rows: the tab name is the compound, the file name says rent, mixed cells are read", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const r = await post(agent, csrf, { filename: "RENT - All.xlsx", tabs: [tab("Villette", [unitRow(1, "VR"), unitRow(2, "VR")]), tab("Mivida", [unitRow(1, "MI")])] });
    expect(r.status).toBe(200);
    const page = await agent.get(r.body.url);
    expect(page.text).toMatch(/data-kind="new"/);
    expect(page.text).toMatch(/Villette · (صف|row) 2/);
    expect(page.text).toMatch(/Mivida · (صف|row) 2/);
    expect(page.text).not.toMatch(/data-kind="invalid"/);
    await agent.post(`${r.body.url}/apply`).type("form").send({ _csrf: csrf, rows: ["1", "3"] });
    const v = await unit("VR1");
    expect(v).toMatchObject({ listing_type: "rent", compound: "Villette", bedrooms: 3, bathrooms: 2 });
    expect(Number(v.price_value)).toBe(25000);
    expect((await unit("MI1")).compound).toBe("Mivida");
  });

  test("a body that is not a workbook, too many tabs, or a column empty on every row is refused with a message", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    expect((await post(agent, csrf, { tabs: [] })).status).toBe(422);
    expect((await post(agent, csrf, { tabs: "x" })).status).toBe(422);
    expect((await post(agent, csrf, { tabs: Array.from({ length: 61 }, (_, i) => tab(`t${i}`, [unitRow(i, "A")])) })).status).toBe(422);
    const noPrice = await post(agent, csrf, { filename: "x.xlsx", tabs: [tab("T", [unitRow(1, "Q", null)])] });
    expect(noPrice.status).toBe(422);
    expect(noPrice.body.empty).toEqual(["price_value"]);
    expect(await h.query("SELECT id FROM web_imports")).toHaveLength(0);
  });

  test("a broker (not a manager) is refused", async () => {
    const { agent, csrf } = await signIn(h, "broker");
    expect((await post(agent, csrf, { tabs: [tab("T", [unitRow(1, "Q")])] })).status).toBe(403);
  });
});

describe("one change for many rows", () => {
  const rows = (n, prefix) => Array.from({ length: n }, (_, i) => unitRow(i + 1, prefix));

  test("a sheet that never says sale or rent: the rows ask for it, one button sets it for all, the edit form offers it", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const r = await post(agent, csrf, { filename: "inventory.xlsx", tabs: [tab("Villette", rows(3, "VR"))] });
    let page = await agent.get(r.body.url);
    expect(page.text).toMatch(/data-kind="invalid"/);
    expect(page.text).toMatch(/data-batch-form="listing_type"/);
    expect(page.text).toMatch(/<select form="edit-1" name="c_listing_type"/);
    // Edit one row only: it becomes ready.
    await agent.post(`${r.body.url}/edit/1`).type("form").send({ _csrf: csrf, c_listing_type: "sale" });
    page = await agent.get(r.body.url);
    expect(page.text).toMatch(/data-kind="new"[\s\S]*data-row="1"/);
    // The rest in one go.
    const b = await agent.post(`${r.body.url}/batch`).type("form").send({ _csrf: csrf, action: "listing_type", value: "rent" });
    expect(b.headers.location).toMatch(/\?batch=2$/);
    page = await agent.get(b.headers.location);
    expect(page.text).toMatch(/data-batch-done/);
    expect(page.text).not.toMatch(/data-kind="invalid"/);
    await agent.post(`${r.body.url}/apply`).type("form").send({ _csrf: csrf, rows: ["1", "2", "3"] });
    expect([(await unit("VR1")).listing_type, (await unit("VR2")).listing_type]).toEqual(["sale", "rent"]);
  });

  test("several prices in one cell: one rule for all of them, the original text is kept", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const data = [unitRow(1, "VR", "long 90k / short 100k / day 6k"), unitRow(2, "VR", "60k negotiable")];
    const r = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", data)] });
    let page = await agent.get(r.body.url);
    expect(page.text).toMatch(/data-batch-form="price_pick"/);
    await agent.post(`${r.body.url}/batch`).type("form").send({ _csrf: csrf, action: "price_pick", value: "long" });
    page = await agent.get(r.body.url);
    expect(page.text).not.toMatch(/data-kind="invalid"/);
    await agent.post(`${r.body.url}/apply`).type("form").send({ _csrf: csrf, rows: ["1", "2"] });
    expect(Number((await unit("VR1")).price_value)).toBe(90000);
    expect((await unit("VR1")).details.notes).toContain("long 90k");
    expect(Number((await unit("VR2")).price_value)).toBe(60000);
  });

  test("a dollar price is saved in dollars with its currency, not converted", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const r = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", [unitRow(1, "VR", "2000$"), unitRow(2, "VR", "25k")])] });
    const page = await agent.get(r.body.url);
    expect(page.text).not.toMatch(/data-kind="invalid"/);
    expect(page.text).toMatch(/data-usd-info/);
    await agent.post(`${r.body.url}/apply`).type("form").send({ _csrf: csrf, rows: ["1", "2"] });
    const usd = await unit("VR1");
    expect(Number(usd.price_value)).toBe(2000);
    expect(usd.details.currency).toBe("USD");
    expect(Number((await unit("VR2")).price_value)).toBe(25000);
    expect((await unit("VR2")).details.currency ?? null).toBeNull();
  });
});

describe("the rows that did not import come back as an Excel file", () => {
  test("original values untouched, tab and sheet row, one new Reason column; the good rows import first", async () => {
    const ExcelJS = require("exceljs");
    const { agent, csrf } = await signIn(h, "manager");
    const r = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", [unitRow(1, "VR"), unitRow(2, "VR", "wait price"), unitRow(3, "VR")])] });
    const page = await agent.get(r.body.url);
    expect(page.text).toMatch(/data-failed-download/);
    await agent.post(`${r.body.url}/apply`).type("form").send({ _csrf: csrf, rows: ["1", "3"] });
    expect(await unit("VR1")).toBeTruthy();
    const f = await agent.get(`${r.body.url}/failed.xlsx`).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(f.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(f.body);
    const ws = wb.worksheets[0];
    const head = ws.getRow(1).values.slice(1);
    expect(head[head.length - 1]).toMatch(/Reason|السبب/);
    expect(head).toContain("price"); // the sheet's own header word
    expect(ws.rowCount).toBe(2);
    const row = ws.getRow(2).values.slice(1);
    expect(row).toContain("wait price"); // the cell as it was
    expect(row[0]).toBe("Villette");
    expect(String(row[row.length - 1])).toMatch(/wait price/);
  });
});

describe("the sheet's own code pattern", () => {
  const withCode = (row, code) => [...row.slice(0, -1), code];
  const coded = (i, code) => withCode(unitRow(i, "ZZ"), code);

  test("a row without a code gets the next number in the tab's pattern, past the agency's own highest; odd codes are noted", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const a = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", [coded(1, "VR-1"), coded(2, "VR-2"), coded(3, "VR-3"), coded(4, ""), coded(5, "XX99")])] });
    const pageA = await agent.get(a.body.url);
    expect(pageA.text).toMatch(/(numbered in the sheet's own pattern|اتعمل بنفس نمط)/);
    expect(pageA.text).toMatch(/(does not follow the sheet's pattern|مش على نمط)/);
    await agent.post(`${a.body.url}/apply`).type("form").send({ _csrf: csrf, rows: ["1", "2", "3", "4", "5"] });
    expect(await unit("VR-4")).toBeTruthy();
    // The next sheet stops at VR-3 but the agency already has VR-4: the new code is VR-5, never an existing unit.
    const b = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", [coded(1, "VR-1"), coded(2, "VR-2"), coded(3, "VR-3"), coded(6, "")])] });
    await agent.get(b.body.url);
    await agent.post(`${b.body.url}/apply`).type("form").send({ _csrf: csrf, all: "1" });
    expect(await unit("VR-5")).toBeTruthy();
    expect((await h.query("SELECT count(*)::int AS n FROM listings WHERE code_norm = 'VR-4'"))[0].n).toBe(1);
  });

  test("no clear pattern: no code is made up", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const a = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", [coded(1, "A1"), coded(2, "ZZ-7"), coded(3, "Q4"), coded(4, "")])] });
    const page = await agent.get(a.body.url);
    expect(page.text).not.toMatch(/(numbered in the sheet's own pattern|اتعمل بنفس نمط)/);
  });
});

describe("a big file is shown a kind and a page at a time", () => {
  test("260 rows over two tabs: problems first, kind and tab links, 50 a page, apply everything ready in one click", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const good = Array.from({ length: 130 }, (_, i) => unitRow(i + 1, "VR"));
    const bad = Array.from({ length: 130 }, (_, i) => unitRow(i + 1, "MI", i < 3 ? "wait price" : "25k"));
    const r = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", good), tab("Mivida", bad)] });
    const first = await agent.get(r.body.url);
    expect(first.text).toMatch(/data-kind-nav/);
    expect(first.text).toMatch(/data-kind="invalid"/); // problems first
    expect(first.text).not.toMatch(/data-kind="new"/);
    expect((first.text.match(/data-tab-link/g) || []).length).toBe(2);
    const newPage = await agent.get(`${r.body.url}?kind=new`);
    expect((newPage.text.match(/<tr data-row=/g) || []).length).toBe(50);
    expect(newPage.text).toMatch(/data-pager/);
    expect(newPage.text).toMatch(/data-apply-all/);
    const second = await agent.get(`${r.body.url}?kind=new&page=2`);
    expect(second.text).toMatch(/<tr data-row="51"|<tr data-row="\d+"/);
    const mivida = await agent.get(`${r.body.url}?kind=invalid&tab=Mivida`);
    expect(mivida.text).toMatch(/Mivida · /);
    expect(mivida.text).not.toMatch(/Villette · /);
  });

  test("apply everything ready creates the units of every page; problem rows are left out", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const rows = [unitRow(1, "VR"), unitRow(2, "VR"), unitRow(3, "VR", "wait price")];
    const filler = Array.from({ length: 200 }, (_, i) => unitRow(i + 10, "ZZ", "wait price"));
    const r = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", [...rows, ...filler])] });
    await agent.post(`${r.body.url}/apply`).type("form").send({ _csrf: csrf, all: "1" });
    expect(await unit("VR1")).toBeTruthy();
    expect(await unit("VR2")).toBeTruthy();
    expect(await unit("VR3")).toBeUndefined();
    expect(await unit("ZZ10")).toBeUndefined();
  });
});

describe("unknown types and unreadable cells", () => {
  test("a type word the app does not know is mapped once for every row; a bad price says what the cell said", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const data = [unitRow(1, "VR"), unitRow(2, "VR"), unitRow(3, "VR", "wait price")];
    data[0][2] = "triplex";
    data[1][2] = "Triplex ";
    const r = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", data)] });
    let page = await agent.get(r.body.url);
    expect(page.text).toMatch(/data-type-word="triplex"/);
    expect(page.text).toMatch(/×2/);
    expect(page.text).toMatch(/«wait price»/);
    await agent.post(`${r.body.url}/batch`).type("form").send({ _csrf: csrf, action: "type_map", from: "triplex", value: "duplex" });
    page = await agent.get(r.body.url);
    expect(page.text).not.toMatch(/data-type-word=/);
    await agent.post(`${r.body.url}/apply`).type("form").send({ _csrf: csrf, rows: ["1", "2"] });
    expect([(await unit("VR1")).property_type, (await unit("VR2")).property_type]).toEqual(["duplex", "duplex"]);
  });
});
