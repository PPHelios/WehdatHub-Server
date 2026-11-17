// tests/web/import-preview-reasons.test.js — QA round 2 (items 26, 27): the Excel preview agrees with the apply about a bad
// owner phone, and says "Price is missing" for a row without a price.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const ExcelJS = require("exceljs");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("manager");
});
afterAll(closeHarness);

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
async function workbook(rows) {
  const wb = new ExcelJS.Workbook();
  const s = wb.addWorksheet("UPtown");
  for (const r of rows) s.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const upload = (agent, csrf, buf) => agent.post("/app/import/excel").field("_csrf", csrf).attach("sheet", buf, { filename: "inv.xlsx", contentType: XLSX });
const HEAD = ["Code", "Compound", "Type", "Purpose", "Price", "Area", "Bedrooms", "Owner phone"];

test("a typed owner phone that is not a mobile is Invalid in the preview, with the number shown", async () => {
  const { agent, csrf } = await signIn(h, "manager");
  const r = await upload(agent, csrf, await workbook([HEAD, ["NH-1", "Hyde Park", "شقة", "بيع", "6 مليون", 110, 2, "123"], ["NH-2", "Hyde Park", "شقة", "بيع", "5 مليون", 100, 2, "01012345678"]]));
  expect(r.status).toBe(303);
  const page = await agent.get(`${r.headers.location}`);
  expect(page.text).toMatch(/data-kind="invalid"[\s\S]*تليفون المالك مش موبايل مصري صحيح: «123»/);
  expect(page.text).toMatch(/data-kind="new"[\s\S]*NH-2/);
});

test("a row without a price says Price is missing", async () => {
  const { agent, csrf } = await signIn(h, "manager");
  const r = await upload(agent, csrf, await workbook([HEAD, ["NH-3", "Hyde Park", "شقة", "بيع", "", 110, 2, "01012345678"], ["NH-4", "Hyde Park", "شقة", "بيع", "5 مليون", 100, 2, "01012345678"]]));
  const page = await agent.get(`${r.headers.location}`);
  expect(page.text).toMatch(/السعر ناقص/);
});

test("a compound that is not on the list is a warning on a New row (not a block) with the Edit window offering the place search", async () => {
  const { agent, csrf } = await signIn(h, "manager");
  const r = await upload(agent, csrf, await workbook([HEAD, ["NH-9", "Mivdia Typo Place", "شقة", "بيع", "5 مليون", 100, 2, "01012345678"]]));
  expect(r.status).toBe(303);
  const page = await agent.get(r.headers.location);
  expect(page.text).toMatch(/data-kind="new"/);
  expect(page.text).toMatch(/مش في القائمة/);
  expect(page.text).not.toMatch(/data-kind="invalid"/);
  // The Edit window is the structured editor: the same place search with suggestions and chips as the WhatsApp import.
  expect(page.text).toMatch(/data-importeditor/);
});
