// tests/web/excel-ui.test.js — The Excel review page: reading card, tabs not read, no-phone banner, background Apply progress,
// partial Apply (the plan stays open), result reasons, mapping override, CSV and .xls uploads, the template's dropdowns.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const ExcelJS = require("exceljs");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Imports = require("../../services/imports");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("manager");
});
afterAll(closeHarness);

const HEAD = ["code", "compound", "type", "purpose", "price", "area", "bedrooms", "owner phone"];
const grid = (name, head, rows) => ({ name, rows: [{ n: 1, v: head }, ...rows.map((v, i) => ({ n: i + 2, v }))] });
const unitRow = (i, phone = "01012345678") => [`UI-${i}`, "Hyde Park", "apartment", "sale", 5000000 + i, 100 + i, 2, phone];
const post = (agent, csrf, body) => agent.post("/app/import/excel/grid").set("X-CSRF-Token", csrf).send(body);
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const waitFor = (id) => Imports.waitForApply(id);

describe("the review page of an Excel plan", () => {
  test("a sheet with no phone column shows the banner; one phone for all rows fixes it; a bad number says so", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const head = HEAD.slice(0, 7);
    const r = await post(agent, csrf, { filename: "inv.xlsx", tabs: [grid("Hyde Park", head, [unitRow(1).slice(0, 7), unitRow(2).slice(0, 7)])] });
    expect(r.status).toBe(200);
    let page = await agent.get(r.body.url);
    expect(page.text).toMatch(/data-no-phone/);
    expect(page.text).toMatch(/data-kind="invalid"/);
    const bad = await agent.post(`${r.body.url}/batch`).type("form").send({ _csrf: csrf, action: "owner_phone", value: "12", scope: "missing" });
    expect(bad.headers.location).toMatch(/batch_error=bad_phone/);
    page = await agent.get(bad.headers.location);
    expect(page.text).toMatch(/data-batch-error="bad_phone"/);
    const ok = await agent.post(`${r.body.url}/batch`).type("form").send({ _csrf: csrf, action: "owner_phone", value: "01012345678", scope: "missing" });
    expect(ok.headers.location).toMatch(/batch=2/);
    page = await agent.get(r.body.url);
    expect(page.text).not.toMatch(/data-no-phone/);
    expect(page.text).toMatch(/data-kind="new"/);
  });

  test("rows have a label, select all / none, and an invalid row says which unit it is and has a Fix button", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const bad = unitRow(3);
    bad[4] = null; // no price
    const r = await post(agent, csrf, { filename: "inv.xlsx", tabs: [grid("Hyde Park", HEAD, [unitRow(1), bad])] });
    const page = await agent.get(r.body.url);
    expect(page.text).toMatch(/<input type="checkbox" name="rows" value="1" aria-label="Hyde Park · (صف|row) 2"/);
    expect(page.text).toMatch(/data-rows-valid/);
    expect(page.text).toMatch(/data-rows-none/);
    expect(page.text).toMatch(/data-card-kind="new"/);
    expect(page.text).toMatch(/data-row-line="2"[^>]*>apartment · Hyde Park/);
    expect(page.text).toMatch(/data-edit-open="2" data-fix/);
  });

  test("the reading card names the columns, what was left out and the tab used as the compound; tabs not read are listed", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const head = ["code", "type", "purpose", "price", "area", "owner phone", "View"];
    const rows = [["RC-1", "apartment", "sale", 5000000, 120, "01012345678", "garden"], ["RC-2", "apartment", "sale", 6000000, 130, "01012345679", "road"]];
    const r = await post(agent, csrf, { filename: "inv.xlsx", tabs: [grid("Mivida", head, rows), { name: "Notes", rows: [{ n: 1, v: ["hello"] }] }], skipped: [{ name: "Old", reason: "hidden" }, { name: "Junk", reason: "weird" }] });
    expect(r.status).toBe(200);
    const page = await agent.get(r.body.url);
    expect(page.text).toMatch(/data-read-card/);
    expect(page.text).toMatch(/data-col-map="price_value"/);
    expect(page.text).toMatch(/data-ignored[^>]*>[^<]*View/);
    expect(page.text).toMatch(/data-compound-from-tab/);
    expect(page.text).toMatch(/data-tabs-not-read[^>]*>[^]*Old[^]*(hidden|مخفي)[^]*Notes[^]*(no known columns|مفيش أعمدة معروفة)/);
    expect(page.text).not.toMatch(/Junk/); // an unknown reason from the browser is dropped
  });

  test("changing how a tab is read re-plans it from the stored grid", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    // "size" and "area" both read as the area; the person says which is which.
    const head = ["code", "compound", "type", "purpose", "price", "area", "bedrooms", "owner phone"];
    const r = await post(agent, csrf, { filename: "inv.xlsx", tabs: [grid("Hyde Park", head, [["MP-1", "Hyde Park", "apartment", "sale", 5000000, 100, 2, "01012345678"]])] });
    const [{ payload }] = await h.query("SELECT payload FROM web_imports WHERE id = $1", [r.body.url.split("/").pop()]);
    expect(payload.grid.tabs).toHaveLength(1);
    const cols = payload.tabs[0].cols;
    const areaCol = cols.find((c) => c.k === "area_value").c;
    const page = await agent.get(r.body.url);
    expect(page.text).toMatch(/data-mapping-form/);
    // Leave the area column out: price/area empty on every row, so the change is refused and the plan stays as it was.
    const refused = await agent.post(`${r.body.url}/mapping`).type("form").send({ _csrf: csrf, tab: "Hyde Park", [`map_${areaCol}`]: "" });
    expect(refused.headers.location).toMatch(/mapping=empty/);
    expect((await agent.get(refused.headers.location)).text).toMatch(/data-mapping-error/);
    // Read the bedrooms column as notes instead: the plan is made again and remembers the choice.
    const bedCol = cols.find((c) => c.k === "bedrooms").c;
    const ok = await agent.post(`${r.body.url}/mapping`).type("form").send({ _csrf: csrf, tab: "Hyde Park", [`map_${bedCol}`]: "notes" });
    expect(ok.status).toBe(303);
    const [{ payload: after }] = await h.query("SELECT payload FROM web_imports WHERE id = $1", [r.body.url.split("/").pop()]);
    expect(after.overrides).toEqual({ "Hyde Park": { [bedCol]: "notes" } });
    expect(after.rows[0].cells.notes).toBe(2);
    expect(after.rows[0].cells.bedrooms).toBeUndefined();
  });
});

describe("Apply in the background", () => {
  test("while applying the page shows a bar, apply-status is JSON, and a finished import shows the result", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const r = await post(agent, csrf, { filename: "inv.xlsx", tabs: [grid("Hyde Park", HEAD, [unitRow(1), unitRow(2)])] });
    const id = r.body.url.split("/").pop();
    // Put the plan into the applying state without a running job: a stale heartbeat would resume it, so keep it fresh.
    await h.query("UPDATE web_imports SET status = 'applying', result = jsonb_build_object('progress', jsonb_build_object('done', 1, 'total', 2), 'heartbeat', to_jsonb(now()::text), 'apply_req', '{\"rows\":[1,2],\"lang\":\"en\"}'::jsonb) WHERE id = $1", [id]);
    const page = await agent.get(r.body.url);
    expect(page.text).toMatch(/data-apply-poll="\/app\/import\/[0-9a-f-]+\/apply-status"/);
    expect(page.text).toMatch(/<progress class="pbar" max="2" value="1">/);
    expect(page.text).not.toMatch(/id="apply-form"/);
    const st = await agent.get(`${r.body.url}/apply-status`);
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ status: "applying", done: 1, total: 2 });
    expect((await agent.get(`/app/import/00000000-0000-0000-0000-000000000000/apply-status`)).status).toBe(404);
  });

  test("applying part of a plan keeps it open: the saved rows are ticked and cannot be sent again; failed units say why", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const r = await post(agent, csrf, { filename: "inv.xlsx", tabs: [grid("Hyde Park", HEAD, [unitRow(1), unitRow(2), unitRow(3)])] });
    const id = r.body.url.split("/").pop();
    const ap = await agent.post(`${r.body.url}/apply`).type("form").send({ _csrf: csrf, rows: ["1"] });
    expect(ap.status).toBe(303);
    await waitFor(id);
    const page = await agent.get(r.body.url);
    expect(page.text).toMatch(/data-result/);
    expect(page.text).toMatch(/data-still-open/);
    expect(page.text).toMatch(/data-row-saved="1"/);
    expect(page.text).toMatch(/name="rows" value="2"/);
    expect(page.text).not.toMatch(/name="rows" value="1"/);
    // The result card shows a failure with its reason (and old results that held the code alone).
    await h.query("UPDATE web_imports SET result = result || $2::jsonb WHERE id = $1", [id, JSON.stringify({ failed: [{ code: "UI-9", reason: "owner_required" }, "OLD-1"], limit_skipped: ["UI-7"] })]);
    const again = await agent.get(r.body.url);
    expect(again.text).toMatch(/UI-9: [^<]*(Owner phone|تليفون المالك)/);
    expect(again.text).toMatch(/OLD-1/);
    expect(again.text).not.toMatch(/\[object Object\]/);
    expect(again.text).toMatch(/UI-7/);
  });
});

describe("files", () => {
  test("a .csv is read on the server like a workbook; an old .xls gets its own message", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const csv = Buffer.from(["code,compound,type,purpose,price,area,bedrooms,owner phone", "CS-1,Hyde Park,apartment,sale,5000000,120,2,01012345678"].join("\n"));
    const ok = await agent.post("/app/import/excel").field("_csrf", csrf).attach("sheet", csv, { filename: "inv.csv", contentType: "text/csv" });
    expect(ok.status).toBe(303);
    expect((await agent.get(ok.headers.location)).text).toMatch(/data-kind="new"/);
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]);
    const xls = await agent.post("/app/import/excel").field("_csrf", csrf).attach("sheet", ole, { filename: "old.xls", contentType: "application/vnd.ms-excel" });
    expect(xls.status).toBe(422);
    expect(xls.text).toMatch(/\.xls/);
    expect(xls.text).toMatch(/\.xlsx/);
  });

  test("the template has dropdown lists, opens right to left in Arabic, and marks the owner phone as needed", async () => {
    const { agent } = await signIn(h, "manager");
    const res = await agent.get("/app/import/template.xlsx").buffer(true).parse((rs, cb) => {
      const chunks = [];
      rs.on("data", (c) => chunks.push(c));
      rs.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const s = wb.getWorksheet("Inventory");
    expect(s.getCell("D2").dataValidation.type).toBe("list");
    expect(s.getCell("D2").dataValidation.formulae[0]).toMatch(/بيع/);
    expect(s.getCell("C2").dataValidation.formulae[0]).toMatch(/شقة/);
    expect(["J2", "O2", "R2"].every((c) => s.getCell(c).dataValidation && s.getCell(c).dataValidation.type === "list")).toBe(true);
    expect(s.views[0].rightToLeft).toBe(true);
    expect(s.getCell("T1").fill.fgColor.argb).toBe("FFB42318"); // owner phone: red
  });
});

void XLSX;
