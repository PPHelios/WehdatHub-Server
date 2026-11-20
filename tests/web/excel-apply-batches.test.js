// tests/web/excel-apply-batches.test.js — Excel import Apply: per-page apply keeps the plan open, runs as a background job that
// writes its record as it goes (crash-safe, resumable, undoable), costs a few queries per 25 rows, and says why a row failed.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const Imports = require("../../services/imports");
const Store = require("../../lib/listingStore");
const Billing = require("../../services/billing");
const CR = require("../../services/compoundResolve");

jest.setTimeout(120000);

let h;
let broker;
beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("manager");
  broker = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.manager.id]))[0];
});
afterEach(() => jest.restoreAllMocks());
afterAll(closeHarness);

const cells = (i, extra = {}) => ({ compound: "Hyde Park", property_type: "apartment", listing_type: "sale", price_value: String(4000000 + i * 500000), area_value: 100 + i * 30, bedrooms: 2 + (i % 3), owner_phone: "01012345678", ...extra });
const sheetOf = (n, make = cells, mapped = ["compound", "property_type", "listing_type", "price_value", "area_value", "bedrooms", "owner_phone"]) => ({
  rows: Array.from({ length: n }, (_, k) => ({ rowNumber: k + 2, tab: "T", sheetRow: k + 2, cells: make(k + 1) })),
  skipped: [],
  mapped
});
async function plan(n, make, mapped) {
  const sheet = sheetOf(n, make, mapped);
  const p = await Imports.planExcel(h.pool, broker, sheet, { lang: "en" });
  const id = await Imports.savePlan(h.pool, broker, "excel", { ...p, rows: sheet.rows, columns: sheet.mapped, skipped: [] }, { filename: "t.xlsx" });
  return { id, plan: p };
}
const row = async (id) => (await h.query("SELECT * FROM web_imports WHERE id = $1", [id]))[0];
const units = async () => h.query("SELECT code FROM listings WHERE agency_id = $1 ORDER BY code", [broker.agency_id]);
const rowsOf = (p, kind) => p.items.filter((i) => i.kind === kind).map((i) => i.row);

describe("per-page Apply keeps the plan open (#2)", () => {
  test("applying some rows leaves the plan ready; the rest can still be fixed in batch and applied; nothing is written twice; Undo covers every Apply", async () => {
    const { id, plan: p } = await plan(8);
    const all = rowsOf(p, "new");
    expect(all).toHaveLength(8);
    const first = await Imports.applyExcel(h.pool, broker, id, { rows: all.slice(0, 3), lang: "en" });
    expect(first.created).toHaveLength(3);
    let imp = await row(id);
    expect(imp.status).toBe("ready");
    expect(imp.payload.applied_rows).toEqual(all.slice(0, 3));
    expect(Imports.remainingRows(imp)).toEqual(all.slice(3));

    // Pressing Apply again on the same rows writes nothing more.
    const again = await Imports.applyExcel(h.pool, broker, id, { rows: all.slice(0, 3), lang: "en" });
    expect(again.created).toHaveLength(3);
    expect(await units()).toHaveLength(3);

    // Batch change and Edit still work on the rows not applied yet, and leave the applied ones alone.
    const batch = await Imports.batchExcel(h.pool, broker, id, { action: "listing_type", value: "rent", scope: "all" }, { lang: "en" });
    expect(batch.touched).toBe(5);
    imp = await row(id);
    expect(imp.payload.rows.filter((r) => r.cells.listing_type === "rent")).toHaveLength(5);
    expect(imp.payload.rows.filter((r) => all.slice(0, 3).includes(r.rowNumber)).every((r) => r.cells.listing_type === "sale")).toBe(true);
    expect(imp.payload.items).toHaveLength(8);
    expect(await Imports.editExcelRow(h.pool, broker, id, all[0], { price_value: "1" }, { lang: "en" })).toBe(false); // applied row
    expect(await Imports.editExcelRow(h.pool, broker, id, all[5], { price_value: "7000000" }, { lang: "en" })).toBe(true);

    const second = await Imports.applyExcel(h.pool, broker, id, { rows: all.slice(3), lang: "en" });
    expect(second.created).toHaveLength(8);
    imp = await row(id);
    expect(imp.status).toBe("applied");
    expect(await units()).toHaveLength(8);
    expect(await Imports.applyExcel(h.pool, broker, id, { rows: all, lang: "en" })).toBeNull();
    expect((await h.query("SELECT listing_type, count(*)::int AS n FROM listings WHERE agency_id = $1 GROUP BY 1 ORDER BY 1", [broker.agency_id]))).toEqual([{ listing_type: "rent", n: 5 }, { listing_type: "sale", n: 3 }]);

    // Undo covers the units of both Applys.
    expect(await Imports.canUndo(h.pool, broker, imp)).toBe(true);
    const out = await Imports.undoExcel(h.pool, broker, id);
    expect(out.archived).toHaveLength(8);
  });

  test("a plan left open with units written can be undone, and then closes", async () => {
    const { id, plan: p } = await plan(4);
    await Imports.applyExcel(h.pool, broker, id, { rows: rowsOf(p, "new").slice(0, 2), lang: "en" });
    const imp = await row(id);
    expect(imp.status).toBe("ready");
    expect(await Imports.canUndo(h.pool, broker, imp)).toBe(true);
    const out = await Imports.undoExcel(h.pool, broker, id);
    expect(out.archived).toHaveLength(2);
    expect((await row(id)).status).toBe("applied");
    expect(await Imports.applyExcel(h.pool, broker, id, { rows: rowsOf(p, "new"), lang: "en" })).toBeNull();
  });
});

describe("Apply is a background job that writes as it goes (#4)", () => {
  test("startApplyExcel returns at once with status applying; a second press gets null; applyStatus follows it", async () => {
    const { id, plan: p } = await plan(3);
    const rows = rowsOf(p, "new");
    const started = await Imports.startApplyExcel(h.pool, broker, id, { rows, lang: "en" });
    expect(started).toEqual({ id, status: "applying" });
    expect((await row(id)).status).toBe("applying");
    expect(await Imports.startApplyExcel(h.pool, broker, id, { rows, lang: "en" })).toBeNull();
    // Edit and batch refuse a plan that is being applied.
    expect(await Imports.editExcelRow(h.pool, broker, id, rows[0], { price_value: "1" }, { lang: "en" })).toBe(false);
    await Imports.waitForApply(id);
    const st = await Imports.applyStatus(h.pool, broker, id);
    expect(st).toMatchObject({ status: "applied", done: 3, total: 3, created: 3, failed: 0, remaining: 0, resumed: false });
  });

  test("a crash after the units were written leaves a record: status applying, the created codes, the undo log; resume finishes without duplicates", async () => {
    const { id, plan: p } = await plan(60);
    const rows = rowsOf(p, "new");
    // The process dies at the end of the run: the last update (status → applied) never happens.
    const real = h.pool.query.bind(h.pool);
    jest.spyOn(h.pool, "query").mockImplementation((text, params) => {
      if (typeof text === "string" && /SET result = \$2::jsonb, status = \$3/.test(text)) return Promise.reject(new Error("process died"));
      return real(text, params);
    });
    jest.spyOn(console, "error").mockImplementation(() => {});
    const started = await Imports.startApplyExcel(h.pool, broker, id, { rows, lang: "en" });
    await expect(Imports.waitForApply(id)).rejects.toThrow("process died");
    h.pool.query.mockRestore();

    const stuck = await row(id);
    expect(stuck.status).toBe("applying");
    expect(stuck.result.created).toHaveLength(60);
    expect(stuck.result.undo.made).toHaveLength(60);
    expect(stuck.result.applied_rows).toHaveLength(60);
    expect(await units()).toHaveLength(60);
    expect(started.status).toBe("applying");

    // While the heartbeat is fresh nothing takes it over and Undo is not offered; once it is stale, it resumes.
    expect((await Imports.applyStatus(h.pool, broker, id)).resumed).toBe(false);
    expect(await Imports.canUndo(h.pool, broker, stuck)).toBe(false);
    await h.query("UPDATE web_imports SET result = jsonb_set(result, '{heartbeat}', to_jsonb((now() - interval '1 hour')::text)) WHERE id = $1", [id]);
    expect(await Imports.canUndo(h.pool, broker, await row(id))).toBe(true); // Undo of what was created stays possible
    const st = await Imports.applyStatus(h.pool, broker, id);
    expect(st.resumed).toBe(true);
    await Imports.waitForApply(id);
    const done = await row(id);
    expect(done.status).toBe("applied");
    expect(done.result.created).toHaveLength(60);
    expect(await units()).toHaveLength(60);
  });

  test("a half-done run resumes only the rows it did not write", async () => {
    const { id, plan: p } = await plan(6);
    const rows = rowsOf(p, "new");
    // Rows 1-3 were written and recorded; the process died before the others.
    await Imports.applyExcel(h.pool, broker, id, { rows: rows.slice(0, 3), lang: "en" });
    await h.query("UPDATE web_imports SET status = 'applying', result = result || jsonb_build_object('apply_req', $2::jsonb, 'heartbeat', to_jsonb((now() - interval '1 hour')::text)) WHERE id = $1", [id, JSON.stringify({ rows, lang: "en", resolutions: {}, photoChoices: {} })]);
    const st = await Imports.applyStatus(h.pool, broker, id);
    expect(st.resumed).toBe(true);
    await Imports.waitForApply(id);
    expect((await units())).toHaveLength(6);
    expect((await row(id)).status).toBe("applied");
  });
});

describe("Apply cost (#12)", () => {
  test("rights and capacity are read once, the code sequence once per transaction, and 60 rows commit in 3 transactions", async () => {
    const cap = jest.spyOn(Billing, "unitCapacity");
    const { id, plan: p } = await plan(60);
    const seen = [];
    const connect = h.pool.connect.bind(h.pool);
    jest.spyOn(h.pool, "connect").mockImplementation(async () => {
      const client = await connect();
      const q = client.query.bind(client);
      client.query = (text, params) => {
        seen.push(typeof text === "string" ? text : text.text);
        return q(text, params);
      };
      return client;
    });
    const res = await Imports.applyExcel(h.pool, broker, id, { rows: rowsOf(p, "new"), lang: "en" });
    h.pool.connect.mockRestore();
    expect(res.created).toHaveLength(60);
    expect(cap).toHaveBeenCalledTimes(1);
    expect(seen.filter((s) => /^BEGIN/.test(s))).toHaveLength(3);
    expect(seen.filter((s) => /^COMMIT/.test(s))).toHaveLength(3);
    expect(seen.filter((s) => /RETURNING code_prefix, unit_code_seq/.test(s))).toHaveLength(3); // one per transaction, not one per row
    expect(seen.filter((s) => /SELECT 1 FROM listings WHERE agency_id = \$1 AND code_norm/.test(s))).toHaveLength(0); // no "taken" check per row
    const codes = (await units()).map((u) => u.code);
    expect(new Set(codes).size).toBe(60);
    // The next auto code carries on after the last one.
    const [{ unit_code_seq }] = await h.query("SELECT unit_code_seq FROM agencies WHERE id = $1", [broker.agency_id]);
    expect(Number(unit_code_seq)).toBeGreaterThanOrEqual(60);
  });

  test("one bad row does not roll back the others in its transaction", async () => {
    const { id, plan: p } = await plan(6);
    const real = Store.createListing;
    let n = 0;
    jest.spyOn(Store, "createListing").mockImplementation((db, b, o) => {
      if (++n === 3) throw new Error("boom");
      return real(db, b, o);
    });
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const res = await Imports.applyExcel(h.pool, broker, id, { rows: rowsOf(p, "new"), lang: "en" });
    expect(res.created).toHaveLength(5);
    expect(res.failed).toEqual([{ code: expect.stringMatching(/row \d+/), reason: "error" }]);
    expect(await units()).toHaveLength(5);
  });

  test("createListing without `shared` still checks rights, capacity and the code itself", async () => {
    const cap = jest.spyOn(Billing, "unitCapacity");
    const { plan: p } = await plan(1);
    const fields = { ...p.items[0].fields, details: { ...p.items[0].fields.details, owner_name: "O" } };
    cap.mockClear();
    const client = await h.pool.connect();
    await client.query("BEGIN");
    const a = await Store.createListing(client, broker, { fields, lang: "en" });
    const b = await Store.createListing(client, broker, { fields, lang: "en" });
    await client.query("COMMIT");
    client.release();
    expect(cap).toHaveBeenCalledTimes(2);
    expect(a.listing.code).not.toBe(b.listing.code);
  });
});

describe("limit and failures (#19, #21)", () => {
  test("when the unit limit stops Apply, the other ticked rows are listed in limit_skipped and the plan stays open", async () => {
    jest.spyOn(Billing, "unitCapacity").mockResolvedValue({ ok: true, used: 0, limit: 3, plan: "free" });
    const { id, plan: p } = await plan(7);
    const rows = rowsOf(p, "new");
    const res = await Imports.applyExcel(h.pool, broker, id, { rows, lang: "en" });
    expect(res.created).toHaveLength(3);
    expect(res.limit).toEqual({ used: 3, limit: 3, plan: "free" });
    expect(res.limit_skipped).toHaveLength(4);
    expect((await row(id)).status).toBe("ready");
  });

  test("a failed row is stored as { code, reason }; the helpers read old string entries too", async () => {
    const { id, plan: p } = await plan(2);
    const real = Store.createListing;
    let n = 0;
    jest.spyOn(Store, "createListing").mockImplementation((db, b, o) => (++n === 1 ? Promise.resolve({ owner_required: true }) : real(db, b, o)));
    const res = await Imports.applyExcel(h.pool, broker, id, { rows: rowsOf(p, "new"), lang: "en" });
    expect(res.failed).toEqual([{ code: expect.any(String), reason: "owner_required" }]);
    expect(Imports.failedLine(res.failed[0], "en")).toMatch(/Owner phone is missing or not valid/);
    expect(Imports.failedLine(res.failed[0], "ar")).toMatch(/تليفون المالك/);
    expect(Imports.failedLine("NH-1", "en")).toBe("NH-1");
    expect(Imports.failedCode("NH-1")).toBe("NH-1");
    expect(Imports.failedCode(res.failed[0])).toBe(res.failed[0].code);
  });
});

describe("plan rules (#3, #20)", () => {
  test("an empty owner phone is invalid at plan time and says so; the sheet without a phone column is flagged", async () => {
    const { plan: p } = await plan(3, (i) => cells(i, { owner_phone: undefined }), ["compound", "property_type", "listing_type", "price_value", "area_value", "bedrooms"]);
    expect(p.items.map((i) => i.kind)).toEqual(["invalid", "invalid", "invalid"]);
    expect(p.items[0].needs).toEqual(["owner_phone"]);
    expect(p.items[0].reasons[0]).toMatch(/Owner phone is required/);
    expect(p.info).toEqual({ no_phone_column: true });
    const withCol = await plan(2);
    expect(withCol.plan.info).toEqual({ no_phone_column: false });
  });

  test("batch 'one phone for all rows' fills the rows that have none and re-plans them", async () => {
    const { id } = await plan(4, (i) => cells(i, i === 2 ? { owner_phone: "01199999999" } : { owner_phone: undefined }), ["compound", "property_type", "listing_type", "price_value", "area_value", "bedrooms"]);
    expect((await row(id)).payload.info.no_phone_column).toBe(true);
    expect(await Imports.batchExcel(h.pool, broker, id, { action: "owner_phone", value: "abc" }, { lang: "en" })).toEqual({ touched: 0, error: "bad_phone" });
    const out = await Imports.batchExcel(h.pool, broker, id, { action: "owner_phone", value: "01012345678" }, { lang: "en" });
    expect(out.touched).toBe(3);
    const imp = await row(id);
    expect(imp.payload.items.map((i) => i.kind)).toEqual(["new", "new", "new", "new"]);
    expect(imp.payload.rows.find((r) => r.rowNumber === 3).cells.owner_phone).toBe("01199999999"); // a row that had a phone keeps it
    expect(imp.payload.info.no_phone_column).toBe(false);
    expect(imp.payload.columns).toContain("owner_phone");
  });

  test("the template's sample rows are invalid with a reason", async () => {
    const { plan: p } = await plan(3, (i) => cells(i, i === 1 ? { code: "SAMPLE-1" } : i === 2 ? { notes: "صف تجريبي، امسحه" } : {}));
    expect(p.items.map((i) => i.kind)).toEqual(["invalid", "invalid", "new"]);
    expect(p.items[0].reasons).toEqual(["Sample row, delete it"]);
    const ar = await Imports.planExcel(h.pool, broker, sheetOf(1, (i) => cells(i, { code: "sample-2" })), { lang: "ar" });
    expect(ar.items[0].reasons[0]).toMatch(/صف تجريبي/);
  });
});

describe("plan duplicate check reads once and gives the same answer (#11)", () => {
  test("the in-memory check equals Store.findDuplicate per row, and a compound is resolved once", async () => {
    await h.approvePlaces([["hyde park", "Hyde Park", "هايد بارك"], ["mivida", "Mivida", "ميفيدا"]]);
    const units = [
      { code: "A-1", compound: "Hyde Park", bedrooms: 2, area_value: 130, price_value: 4.5e6 },
      { code: "A-2", compound: "هايد بارك", bedrooms: 3, area_value: 160, price_value: 5e6 },
      { code: "A-3", compound: "Mivida", bedrooms: 2, area_value: 131, price_value: 4.6e6 },
      { code: "A-4", compound: "Hyde Park", bedrooms: 2, area_value: 500, price_value: 9e6 },
      { code: "A-5", compound: null, district: "Maadi", bedrooms: 1, area_value: 90, price_value: 2e6 },
      { code: "A-6", compound: "Hyde Park", bedrooms: 2, area_value: 129, price_value: 4.55e6, status: "sold" }
    ];
    for (const u of units) await h.insertListing({ ...u, details: { owner_phone: "01012345678" } });
    const probes = [
      { compound: "Hyde Park", bedrooms: 2, area_value: 130, price_value: 4.5e6, listing_type: "sale", property_type: "apartment" },
      { compound: "هايد بارك", bedrooms: 3, area_value: 158, price_value: 5.1e6, listing_type: "sale", property_type: "apartment" },
      { compound: "Hyde Park", bedrooms: 3, area_value: 158, price_value: 5.1e6, listing_type: "sale", property_type: "apartment" },
      { compound: "Mivida", bedrooms: 2, area_value: 130, price_value: 4.6e6, listing_type: "sale", property_type: "apartment" },
      { compound: "ميفيدا", bedrooms: 2, area_value: 130, price_value: 4.6e6, listing_type: "sale", property_type: "apartment" },
      { compound: "Hyde Park", bedrooms: 2, area_value: 130, price_value: 4.5e6, listing_type: "rent", property_type: "apartment" },
      { compound: "Hyde Park", bedrooms: 2, area_value: 500, price_value: 9e6, listing_type: "sale", property_type: "villa" },
      { compound: "Nowhere", bedrooms: 2, area_value: 130, price_value: 4.5e6, listing_type: "sale", property_type: "apartment" },
      { district: "Maadi", bedrooms: 1, area_value: 91, price_value: 2.05e6, listing_type: "sale", property_type: "apartment" },
      { compound: "Hyde Park", bedrooms: 2, area_value: 129, price_value: 4.55e6, listing_type: "sale", property_type: "apartment" },
      { compound: "Hyde Park", bedrooms: 2, area_value: 0, price_value: 4.5e6 },
      { compound: "Hyde Park", compound_en: "Hyde Park", bedrooms: 2, area_value: 130, price_value: 4.5e6, listing_type: "sale" }
    ];
    const index = await Store.duplicateIndex(h.pool, broker.agency_id);
    const resolve = jest.spyOn(CR, "resolve");
    for (const l of probes) {
      const old = await Store.findDuplicate(h.pool, broker.agency_id, l);
      const named = l.compound && !l.compound_en ? await CR.resolve(h.pool, { compound: l.compound }).catch(() => null) : null;
      expect(index.find(l, named)).toBe(old);
    }
    expect(probes.map((l) => index.find(l, l.compound && !l.compound_en ? null : null)).filter(Boolean).length).toBeGreaterThan(0);
    resolve.mockClear();

    // The whole plan: same warnings as the per-row path (a plan of 5 rows or fewer), one resolve per distinct compound.
    const make = (i) => ({ compound: i % 2 ? "Hyde Park" : "Mivida", property_type: "apartment", listing_type: "sale", price_value: i % 2 ? "4500000" : "4600000", area_value: i % 2 ? 130 : 131, bedrooms: 2, owner_phone: "01012345678" });
    const big = await Imports.planExcel(h.pool, broker, sheetOf(12, make), { lang: "en" });
    const calls = resolve.mock.calls.length;
    const small = [];
    for (const r of sheetOf(12, make).rows) small.push(...(await Imports.planExcel(h.pool, broker, { rows: [r], skipped: [] }, { lang: "en" })).items);
    const strip = (items) => items.map((i) => ({ row: i.row, kind: i.kind, warnings: (i.warnings || []).filter((w) => /Looks like your existing/.test(w)) }));
    expect(strip(big.items)).toEqual(strip(small));
    expect(strip(big.items).some((i) => i.warnings.length)).toBe(true);
    expect(calls).toBeLessThanOrEqual(2 * 2); // two distinct compounds: resolved once each (plus the unknown-compound check shares the result)
  });
});

describe("editing a plan row", () => {
  test("a write that lost a race is refused, not overwritten (xmin guard)", async () => {
    const { id } = await plan(3);
    // Another save lands between this edit's read and its write.
    const racing = { query: async (sql, args) => {
      if (/^UPDATE web_imports SET payload/.test(sql)) await h.pool.query("UPDATE web_imports SET payload = jsonb_set(payload, '{marker}', '1'::jsonb) WHERE id = $1", [id]);
      return h.pool.query(sql, args);
    } };
    expect(await Imports.editExcelRow(racing, broker, id, 2, { price_value: "9000000" }, { lang: "en" })).toBe(false);
    const imp = await row(id);
    expect(imp.payload.marker).toBe(1);
    expect(imp.payload.rows[0].cells.price_value).not.toBe("9000000");
    // The same guard makes a batch change report a conflict.
    const out = await Imports.batchExcel({ query: racing.query, connect: (...a) => h.pool.connect(...a) }, broker, id, { action: "listing_type", value: "rent", scope: "all" }, { lang: "en" });
    expect(out).toEqual({ touched: 0, error: "conflict" });
  });

  test("the twin of a repeated code becomes valid when the first row's code changes", async () => {
    const { id, plan: p } = await plan(3, (i) => cells(i, { code: i === 3 ? "X-9" : "X-1" }), ["code", "compound", "property_type", "listing_type", "price_value", "area_value", "bedrooms", "owner_phone"]);
    expect(p.items.find((i) => i.row === 3).reasons[0]).toMatch(/repeated/);
    expect(await Imports.editExcelRow(h.pool, broker, id, 2, { code: "X-2" }, { lang: "en" })).toBe(true);
    const items = (await row(id)).payload.items;
    expect(items.find((i) => i.row === 3).kind).toBe("new");
  });
});
