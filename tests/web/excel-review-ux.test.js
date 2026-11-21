// tests/web/excel-review-ux.test.js — The Excel review page: the confirm text matches what Save all saves, the diff download,
// small multi-tab files get tab chips, oversize bodies answer 413, and data entry is kept out of the Excel routes.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const ExcelJS = require("exceljs");
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
const binary = (res, cb) => {
  const c = [];
  res.on("data", (d) => c.push(Buffer.from(d)));
  res.on("end", () => cb(null, Buffer.concat(c)));
};

test("the Save all button says how many units are added and changed, and saves exactly those; the diff is an Excel file", async () => {
  const { agent, csrf } = await signIn(h, "manager");
  const first = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", [unitRow(1, "VR"), unitRow(2, "VR")])] });
  await agent.post(`${first.body.url}/apply`).type("form").send({ _csrf: csrf, all: "1" });
  // VR1 now has another price (changed), VR3 and VR4 are new.
  const r = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", [unitRow(1, "VR", "30k"), unitRow(3, "VR"), unitRow(4, "VR")])] });
  const page = await agent.get(r.body.url);
  expect(page.text).toMatch(/data-apply-all data-confirm="[^"]*(Add 2 new units and change 1 existing|هنضيف 2 وحدة جديدة ونعدّل 1 وحدة)/);
  expect(page.text).toMatch(/data-diff-download/);
  const diff = await agent.get(`${r.body.url}/diff.xlsx`).buffer(true).parse(binary);
  expect(diff.status).toBe(200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(diff.body);
  const ws = wb.worksheets[0];
  expect(ws.getRow(1).values.slice(1)).toEqual(["الكود", "التاب", "الصف", "الخانة", "من", "إلى"]);
  const row = ws.getRow(2).values.slice(1);
  expect(row[0]).toBe("VR1");
  expect(row[1]).toBe("Villette");
  expect(String(row[4])).toMatch(/25/);
  expect(String(row[5])).toMatch(/30/);
  expect(ws.rowCount).toBe(2);

  await agent.post(`${r.body.url}/apply`).type("form").send({ _csrf: csrf, all: "1" });
  const [imp] = await h.query("SELECT result FROM web_imports WHERE id = $1", [r.body.url.split("/").pop()]);
  expect([imp.result.created.length, imp.result.updated.length]).toEqual([2, 1]);
});

test("diff.xlsx: a chat import has none, and data entry is refused", async () => {
  const { agent, csrf } = await signIn(h, "manager");
  const r = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", [unitRow(1, "VR")])] });
  const id = r.body.url.split("/").pop();
  await h.pool.query("UPDATE web_imports SET kind = 'group' WHERE id = $1", [id]);
  expect((await agent.get(`${r.body.url}/diff.xlsx`)).status).toBe(404);
  await h.pool.query("UPDATE web_imports SET kind = 'excel' WHERE id = $1", [id]);
  await h.pool.query("UPDATE brokers SET role = 'data_entry' WHERE id = $1", [h.BROKERS.colleague.id]);
  const de = await signIn(h, h.BROKERS.colleague);
  expect((await de.agent.get(`${r.body.url}/diff.xlsx`)).status).toBe(403);
});

test("data entry gets 403 on every Excel route and does not see the Excel upload", async () => {
  await h.pool.query("UPDATE brokers SET role = 'data_entry' WHERE id = $1", [h.BROKERS.colleague.id]);
  const { agent, csrf } = await signIn(h, h.BROKERS.colleague);
  expect((await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", [unitRow(1, "VR")])] })).status).toBe(403);
  expect((await agent.post("/app/import/excel").set("X-CSRF-Token", csrf)).status).toBe(403);
  for (const p of ["failed", "fixed", "diff"]) expect((await agent.get(`/app/import/00000000-0000-0000-0000-000000000000/${p}.xlsx`)).status).toBe(403);
  expect((await agent.get("/app/import")).text).not.toContain('action="/app/import/excel"');
});

test("a small file with two tabs shows the tab chips (and no kind tabs); a chip shows only that tab", async () => {
  const { agent, csrf } = await signIn(h, "manager");
  const r = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", [unitRow(1, "VR"), unitRow(2, "VR")]), tab("Mivida", [unitRow(1, "MI")])] });
  const page = await agent.get(r.body.url);
  expect((page.text.match(/data-tab-link/g) || []).length).toBe(2);
  expect(page.text).not.toMatch(/data-kind-nav/);
  expect(page.text).toMatch(/data-counts/);
  const one = await agent.get(`${r.body.url}?tab=Mivida`);
  expect(one.text).toMatch(/Mivida · /);
  expect(one.text).not.toMatch(/Villette · /);
});

test("a file of more than 30 rows is shown one kind and one page at a time, with Save all", async () => {
  const { agent, csrf } = await signIn(h, "manager");
  const rows = Array.from({ length: 35 }, (_, i) => unitRow(i + 1, "VR"));
  const r = await post(agent, csrf, { filename: "RENT.xlsx", tabs: [tab("Villette", rows)] });
  const page = await agent.get(r.body.url);
  expect(page.text).toMatch(/data-kind-nav/);
  expect(page.text).toMatch(/data-apply-all/);
  expect(page.text).not.toMatch(/role="tablist"/);
  expect(page.text).toMatch(/data-counts/);
  expect((page.text.match(/<tr data-row=/g) || []).length).toBe(35);
});

test("a JSON body over the limit answers 413 with the too-large text, not a server error", async () => {
  const { agent, csrf } = await signIn(h, "manager");
  const big = await agent.post("/app/import/excel/grid").set("X-CSRF-Token", csrf).send({ filename: "x.xlsx", tabs: [{ name: "a", rows: [] }], pad: "x".repeat(7 * 1024 * 1024) });
  expect(big.status).toBe(413);
  expect(big.body.message).toMatch(/(too large|كبير)/);
});
