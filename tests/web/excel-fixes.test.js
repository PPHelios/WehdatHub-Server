// tests/web/excel-fixes.test.js — Excel-only fixes: empty required columns refused, compound and code rewrites shown,
// currency and phone checks, a reason for every row that is not imported.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const ExcelJS = require("exceljs");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const SheetImport = require("../../domain/sheetImport");

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
const HEAD = ["الكود", "الكمبوند", "النوع", "بيع او ايجار", "السعر", "المساحة", "الغرف"];
const unit = async (code) => (await h.query("SELECT * FROM listings WHERE code_norm = upper($1)", [code]))[0];

describe("pure rules", () => {
  test("a dollar or euro price is flagged, not read as a number", () => {
    expect(SheetImport.rowToDraft({ code: "A-1", price_value: "$150,000", area_value: 100 }).errors).toEqual(["currency"]);
    expect(SheetImport.rowToDraft({ code: "A-1", price_value: "€ 90k", area_value: 100 }).errors).toEqual(["currency"]);
    expect(SheetImport.rowToDraft({ code: "A-1", price_value: "8.5 مليون", area_value: 100 }).errors).toEqual([]);
  });

  test("a required column empty across the whole tab is reported; a tab with no rows reports nothing", () => {
    const rows = [{ cells: { code: "A-1", area_value: 100 } }, { cells: { code: "A-2", area_value: 120 } }];
    expect(SheetImport.emptyRequired(rows)).toEqual(["price_value"]);
    expect(SheetImport.emptyRequired([])).toEqual([]);
  });
});

describe("Excel fixes in the review", () => {
  test("a tab with the price column empty on every row is refused, and nothing is saved", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const r = await upload(agent, csrf, await workbook([HEAD, ["NH-1", "UPtown cairo", "شقة", "بيع", "", 120, 2]]));
    expect(r.status).toBe(422);
    expect(r.text).toMatch(/data-import-error="empty-column"/);
    expect(r.text).toMatch(/السعر/);
    expect(await h.query("SELECT id FROM web_imports")).toHaveLength(0);
  });

  test("a compound written without the city word is matched to the agency's own spelling, and the change is shown", async () => {
    await h.insertListing({ code: "UP-1", compound: "UPtown cairo", price_value: 5e6, area_value: 100 });
    const { agent, csrf } = await signIn(h, "manager");
    const r = await upload(agent, csrf, await workbook([HEAD, ["UP-2", "UPtown", "شقة", "بيع", "6 مليون", 110, 2]]));
    expect(r.status).toBe(303);
    const page = await agent.get(r.headers.location);
    expect(page.text).toMatch(/data-notes="2"[^>]*>الكمبوند &quot;UPtown&quot; اتربط بـ &quot;UPtown cairo&quot;/);
    // Review only: nothing written until the broker applies.
    expect(await unit("UP-2")).toBeUndefined();
  });

  test("a code written in lower case is shown as the code it becomes", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const r = await upload(agent, csrf, await workbook([HEAD, ["hp-7", "Hyde Park", "شقة", "بيع", "6 مليون", 110, 2]]));
    const page = await agent.get(r.headers.location);
    expect(page.text).toMatch(/data-notes="2"[^>]*>الكود اتكتب HP-7/);
  });

  test("a dollar price and a text-only row each show their reason; an owner phone that is not Egyptian is flagged", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const head = [...HEAD, "تليفون المالك"];
    const r = await upload(
      agent,
      csrf,
      await workbook([
        head,
        ["NH-5", "Hyde Park", "شقة", "بيع", "$150,000", 110, 2, ""],
        ["NH-6", "Hyde Park", "شقة", "بيع", "6 مليون", 110, 2, "12345"],
        ["", "", "", "", "", "", "", ""]
      ])
    );
    expect(r.status).toBe(303);
    const page = await agent.get(r.headers.location);
    expect(page.text).toMatch(/السعر بعملة غير الجنيه/);
    expect(page.text).toMatch(/data-notes="3"[^>]*>تليفون المالك مش شكل موبايل مصري/);
  });

  test("a row with text only in a column the app does not know is reported, not dropped", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const r = await upload(agent, csrf, await workbook([[...HEAD, "Random"], ["NH-7", "Hyde Park", "شقة", "بيع", "6 مليون", 110, 2, ""], ["", "", "", "", "", "", "", "just a memo"]]));
    expect(r.status).toBe(303);
    const page = await agent.get(r.headers.location);
    expect(page.text).toMatch(/صف 3: مفيش قيمة في عمود معروف|Row 3: No value in a known column/);
  });

  test("an unchanged unit shows its row and that nothing changes", async () => {
    await h.insertListing({ code: "HP-1", compound: "Hyde Park", price_value: 6e6, area_value: 110, bedrooms: 2 });
    const { agent, csrf } = await signIn(h, "manager");
    const r = await upload(agent, csrf, await workbook([HEAD, ["HP-1", "Hyde Park", "شقة", "بيع", "6 مليون", 110, 2]]));
    const page = await agent.get(r.headers.location);
    expect(page.text).toMatch(/data-kind="unchanged"[\s\S]*data-row="2"[\s\S]*مفيش حاجة هتتغير/);
  });
});
