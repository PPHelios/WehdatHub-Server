// tests/web/excel-parts.test.js — A big workbook arrives as parts: each part posted with its "(part i of n)" name is stored as its own import.
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

test("a part posted with its '(part i of n)' name is stored as its own import, one per part", async () => {
  const { agent, csrf } = await signIn(h, "manager");
  const name = "RENT - All.xlsx (part 2 of 2)";
  const r = await post(agent, csrf, { filename: name, tabs: [tab("Villette", [unitRow(1, "VR")])] });
  expect(r.status).toBe(200);
  expect(r.body.url).toMatch(/^\/app\/import\/[0-9a-f-]{36}$/);
  const rows = await h.query("SELECT kind, status, filename FROM web_imports");
  expect(rows).toEqual([{ kind: "excel", status: "ready", filename: name }]);
  const page = await agent.get(r.body.url);
  expect(page.status).toBe(200);
  expect(page.text).toMatch(/data-kind="new"/);
});
