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

  test("a code written in lower case or with a space is normalised, not flagged", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const r = await upload(agent, csrf, await workbook([[...HEAD, "تليفون المالك"], ["hp 7", "Hyde Park", "شقة", "بيع", "6 مليون", 110, 2, "01012345678"]]));
    const page = await agent.get(r.headers.location);
    expect(page.text).toMatch(/data-kind="new"[\s\S]*HP7/);
    expect(page.text).not.toMatch(/data-kind="invalid"/);
    expect(page.text).not.toMatch(/data-notes=/);
  });

  test("a euro price and a text-only row each show their reason; an owner phone that is not a valid number is flagged", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const head = [...HEAD, "تليفون المالك"];
    const r = await upload(
      agent,
      csrf,
      await workbook([
        head,
        ["NH-5", "Hyde Park", "شقة", "بيع", "€150,000", 110, 2, ""],
        ["NH-6", "Hyde Park", "شقة", "بيع", "6 مليون", 110, 2, "12345"],
        ["", "", "", "", "", "", "", ""]
      ])
    );
    expect(r.status).toBe(303);
    const page = await agent.get(r.headers.location);
    expect(page.text).toMatch(/السعر بعملة غير الجنيه/);
    expect(page.text).toMatch(/data-notes="3"[^>]*>تليفون المالك مش شكل رقم صحيح/);
  });

  test("a row with text only in a column the app does not know, or a single value, is dropped, not shown as an error", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const r = await upload(agent, csrf, await workbook([[...HEAD, "Random"], ["NH-7", "Hyde Park", "شقة", "بيع", "6 مليون", 110, 2, ""], ["", "", "", "", "", "", "", "just a memo"], ["", "", "", "", "", 120, "", ""]]));
    expect(r.status).toBe(303);
    const page = await agent.get(r.headers.location);
    expect(page.text).not.toMatch(/مفيش قيمة في عمود معروف|No value in a known column/);
    expect(page.text).not.toMatch(/صف 3|صف 4|Row 3|Row 4/);
  });

  test("an unchanged unit shows its row and that nothing changes", async () => {
    await h.insertListing({ code: "HP-1", compound: "Hyde Park", price_value: 6e6, area_value: 110, bedrooms: 2 });
    const { agent, csrf } = await signIn(h, "manager");
    const r = await upload(agent, csrf, await workbook([HEAD, ["HP-1", "Hyde Park", "شقة", "بيع", "6 مليون", 110, 2]]));
    const page = await agent.get(r.headers.location);
    expect(page.text).toMatch(/data-kind="unchanged"[\s\S]*data-row="2"[\s\S]*مفيش حاجة هتتغير/);
  });
});

describe("facts hidden in a text cell", () => {
  const Imports = require("../../services/imports");
  const plan = async (cells) => {
    const broker = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.manager.id]))[0];
    const p = await Imports.planExcel(h.pool, broker, { rows: [{ rowNumber: 2, tab: "T", sheetRow: 2, cells }], skipped: [] }, { lang: "en" });
    return p.items[0];
  };

  test("a whole unit in one notes cell is read, and the row says so", async () => {
    const text = "شقة 3 غرف 150م التجمع الخامس 4 مليون 01012345678";
    const bare = await plan({ notes: text, listing_type: "sale" });
    expect(bare.needs).toEqual(["compound"]); // price, area, type, rooms and phone were all read
    const item = await plan({ notes: text, listing_type: "sale", compound: "UPtown cairo" });
    expect(item.kind).not.toBe("invalid");
    expect(item.fields).toMatchObject({ price_value: 4e6, area_value: 150, bedrooms: 3, property_type: "apartment" });
    expect(item.fields.details.owner_phone).toBeTruthy();
    expect(item.notes.join(" ")).toMatch(/Read from text: .*price.*area.*type/);
  });

  test("an area mixed into the price cell fills the empty area", async () => {
    const item = await plan({ compound: "UPtown cairo", property_type: "apartment", listing_type: "sale", owner_phone: "01012345678", bedrooms: 3, price_value: "4 مليون 150م" });
    expect(item.fields).toMatchObject({ price_value: 4e6, area_value: 150 });
  });

  test("a row that has price, area and type but no phone does not run the text reader", async () => {
    const spy = jest.spyOn(require("../../domain/chatListing"), "parsePost");
    await plan({ compound: "UPtown cairo", property_type: "apartment", listing_type: "sale", price_value: "5 مليون", area_value: 200, notes: "شقة 3 غرف 150م 4 مليون" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test("the Edit window of a one-cell unit holds the values read from the text, and the review keeps its note", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const r = await upload(agent, csrf, await workbook([["الكمبوند", "ملاحظات", "السعر", "المساحة"], ["", "شقة للبيع 3 غرف 150م التجمع الخامس 4 مليون 01012345678", "", ""], ["UPtown", "", "5 مليون", 100]]));
    const id = r.headers.location.split("/").pop();
    const win = await agent.get(`/app/import/${id}/dialog/2`);
    expect(win.status).toBe(200);
    expect(win.text).toMatch(/name="c_price_value"[^>]*value="4000000"|value="4000000"[^>]*name="c_price_value"|name="c_price_value"[^>]*value="4 مليون"/);
    expect(win.text).toMatch(/name="c_area_value"[^>]*value="150/);
    expect(win.text).not.toMatch(/data-missing="price_value"/);
    // Saving the Edit window plans the row again: the note stays, and an edited price wins over the text.
    await agent.post(`/app/import/${id}/edit/2`).set("X-CSRF-Token", csrf).type("form").send({ c_price_value: "5 مليون" }).expect(303);
    const page = await agent.get(`/app/import/${id}`);
    expect(page.text).toMatch(/اتقرا من النص/);
    const [{ payload }] = await h.query("SELECT payload FROM web_imports WHERE id = $1", [id]);
    expect(payload.items.find((i) => i.row === 2).fields.price_value).toBe(5e6);
  });

  test("a value in its own column is never overwritten by text", async () => {
    const item = await plan({ compound: "UPtown cairo", property_type: "villa", listing_type: "sale", price_value: "5 مليون", area_value: 200, bedrooms: 3, notes: "شقة 150م 4 مليون 01012345678" });
    expect(item.fields).toMatchObject({ price_value: 5e6, area_value: 200, property_type: "villa" });
  });
});

