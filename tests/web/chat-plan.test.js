// tests/web/chat-plan.test.js — Chat import through the Excel planner: parser first, AI only for what is missing, a code written in
// a post is the unit's code, same code on another unit asks (merge or a new code), photos are picked, applied and undone.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const sharp = require("sharp");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");

jest.setTimeout(90000);

let h;
let aiCalls;
beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("manager");
  h.Storage.reset();
  aiCalls = 0;
  h.AI.respond((c) => {
    if (c.operation !== "listing_extraction") return null;
    aiCalls++;
    return { listing_type: "sale", market: "resale", property_type: "apartment", compound: "Hyde Park", area_value: 150, bedrooms: 3, price_value: 8600000 };
  });
});
afterAll(closeHarness);

async function distinct(k) {
  let a = 0x9e3779b9 + k * 7919;
  const rnd = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const grid = Buffer.from(Array.from({ length: 72 }, () => Math.floor(rnd() * 256)));
  return sharp(grid, { raw: { width: 9, height: 8, channels: 1 } }).resize(300, 300, { kernel: "nearest" }).jpeg().toBuffer();
}
const photo = (agent, csrf, url, buf) => agent.post(url).set("X-CSRF-Token", csrf).attach("photo", buf, { filename: "photo.jpg", contentType: "image/jpeg" });
const plan = (agent, csrf, posts) => agent.post("/app/import/match/plan").set("X-CSRF-Token", csrf).send({ filename: "chat.zip", posts });
const loadPlan = async (id) => (await h.query("SELECT payload, status, result FROM web_imports WHERE id = $1", [id]))[0];

// Row 1 is the same unit as HP-1 with a slightly new price; row 2 uses the code HP-2 of another unit; row 3 names no code.
const POSTS = [
  { sender: "Ali", at: "24/10/2026 10:15", text: "شقة للبيع كود HP-1 مساحة 150 متر 3 غرف السعر 8.6 مليون 01012345678" },
  { sender: "Ali", at: "24/10/2026 10:16", text: "فيلا للبيع Hyde Park كود HP-2 مساحة 400 متر 5 غرف السعر 20 مليون 01012345678" },
  { sender: "Ali", at: "24/10/2026 10:17", text: "شقة للبيع مساحة 90 متر 2 غرف السعر 3 مليون الدور الثاني 01012345678" }
];

describe("chat import plan", () => {
  test("the parser reads the posts, AI is asked only for the cells it left empty, and the code from the post is used", async () => {
    await h.insertListing({ code: "HP-1" });
    await h.insertListing({ code: "HP-2" });
    const { agent, csrf } = await signIn(h, "manager");
    const res = await plan(agent, csrf, POSTS);
    expect(res.status).toBe(200);
    expect(res.body.posts).toBe(3);
    expect(aiCalls).toBeGreaterThan(0); // the compound is missing from the posts without a known place
    const { payload } = await loadPlan(res.body.id);
    expect(payload.source).toBe("chat");
    const byRow = Object.fromEntries(payload.items.map((i) => [i.row, i]));
    expect(byRow[1]).toMatchObject({ kind: "changed", code: "HP-1" }); // same unit: a comparison, not a new unit
    expect(byRow[1].changes.some((c) => c.field === "price_value")).toBe(true);
    expect(byRow[2]).toMatchObject({ kind: "review", code: "HP-2", code_taken: true }); // same code, another unit: ask
    expect(byRow[2].merge.code).toBe("HP-2");
    expect(payload.parsed["1"].code).toBe("HP-1"); // what the parser read is kept to measure its quality
    const logs = await h.query("SELECT metadata FROM operation_logs WHERE operation_type = 'chat_parse'");
    expect(logs).toHaveLength(3);
    expect(logs.every((l) => !/01012345678/.test(JSON.stringify(l.metadata)))).toBe(true);
  });

  test("review: merge updates the unit, a typed code makes a new unit; photos are picked, old ones removed, and undo puts it back", async () => {
    const a = await h.insertListing({ code: "HP-1" });
    await h.insertListing({ code: "HP-2" });
    for (let k = 0; k < 14; k++) await h.query("INSERT INTO listing_images (listing_id, agency_id, position, url) VALUES ($1, $2, $3, $4)", [a.id, h.AGENCY_A, k, `${h.Storage.BASE}old${k}.jpg`]);
    const { agent, csrf } = await signIn(h, "manager");
    const id = (await plan(agent, csrf, POSTS)).body.id;
    // Row 1 (merge target HP-1 with 14 photos) gets 3 new photos: only one fits unless an old one is removed.
    for (let k = 0; k < 3; k++) expect((await photo(agent, csrf, `/app/import/match/p/${id}/photo/1`, await distinct(k))).body.ok).toBe(true);
    const page = (await agent.get(`/app/import/${id}?kind=changed`)).text;
    expect(page).toMatch(/data-photo-pick="1"/);
    expect((await agent.get(`/app/import/${id}`)).text).toMatch(/name="res_2"/); // the review tab opens first and asks merge or new code
    expect(page).toMatch(/chatreview\.js/);

    const [oldFirst] = await h.query("SELECT id FROM listing_images WHERE listing_id = $1 ORDER BY position LIMIT 1", [a.id]);
    const body = `rows=1&rows=2&picked_1=1&keep_1=0&keep_1=1&keep_1=2&drop_1=${oldFirst.id}&res_2=new&code_2=HP-9`;
    const apply = await agent.post(`/app/import/${id}/apply`).set("X-CSRF-Token", csrf).type("form").send(body);
    expect(apply.status).toBeLessThan(400);

    const units = await h.query("SELECT code, price_value FROM listings WHERE agency_id = $1 ORDER BY code", [h.AGENCY_A]);
    expect(units.map((u) => u.code)).toEqual(["HP-1", "HP-2", "HP-9"]);
    expect(Number(units[0].price_value)).toBe(8600000);
    expect(Number(units[1].price_value)).toBe(8500000); // HP-2 itself is untouched: the post became HP-9
    const imgs = await h.query("SELECT url FROM listing_images WHERE listing_id = $1", [a.id]);
    expect(imgs).toHaveLength(15); // 14 - 1 removed + 2 that fit (never over 15)
    expect(imgs.some((i) => i.url.endsWith("old0.jpg"))).toBe(false);

    const undo = await agent.post(`/app/import/${id}/undo`).set("X-CSRF-Token", csrf);
    expect(undo.status).toBeLessThan(400);
    const back = await h.query("SELECT url FROM listing_images WHERE listing_id = $1", [a.id]);
    expect(back).toHaveLength(14);
    expect(back.some((i) => i.url.endsWith("old0.jpg"))).toBe(true);
    const after = await h.query("SELECT price_value FROM listings WHERE code = 'HP-1' AND agency_id = $1", [h.AGENCY_A]);
    expect(Number(after[0].price_value)).toBe(8500000);
  });

  test("the browser's step log is saved, the unit photo list and removal work, and brokers are refused", async () => {
    const a = await h.insertListing({ code: "HP-1" });
    await h.query("INSERT INTO listing_images (listing_id, agency_id, position, url) VALUES ($1, $2, 0, $3)", [a.id, h.AGENCY_A, `${h.Storage.BASE}x.jpg`]);
    const { agent, csrf } = await signIn(h, "manager");
    expect((await agent.post("/app/import/match/log").set("X-CSRF-Token", csrf).send({ steps: [{ step: "read_zip", ms: 120, ok: true }, { step: "upload", ms: 50, ok: false, error: "storage" }] })).body.ok).toBe(true);
    const steps = await h.query("SELECT status, error_code, metadata->>'step' AS step FROM operation_logs WHERE operation_type = 'chat_import_step' ORDER BY step");
    expect(steps.map((s) => [s.step, s.status])).toEqual([["read_zip", "ok"], ["upload", "error"]]);
    const list = await agent.get("/app/import/match/unit/HP-1/photos");
    expect(list.body.photos).toHaveLength(1);
    const del = await agent.post("/app/import/match/unit/HP-1/photos/remove").set("X-CSRF-Token", csrf).send({ ids: [list.body.photos[0].id] });
    expect(del.body.removed).toBe(1);
    const broker = await signIn(h, "broker");
    expect((await broker.agent.post("/app/import/match/plan").set("X-CSRF-Token", broker.csrf).send({ posts: POSTS })).status).toBe(403);
  });
});

describe("editing a unit before saving keeps the photo choices", () => {
  test("the order and ticks sent with the edit are shown again; apply saves the photos in the chosen order", async () => {
    await h.insertListing({ code: "HP-1" });
    const { agent, csrf } = await signIn(h, "manager");
    const id = (await plan(agent, csrf, POSTS)).body.id;
    const photos = [];
    for (let k = 0; k < 3; k++) {
      const r = await photo(agent, csrf, `/app/import/match/p/${id}/photo/1`, await distinct(40 + k));
      expect(r.body.ok).toBe(true);
    }
    const urls = (await loadPlan(id)).payload.photos["1"].map((p) => p.url);
    photos.push(...urls);
    // The person moved photo 2 first, unticked photo 1 and saved an edit of the price.
    const edit = await agent.post(`/app/import/${id}/edit/1`).set("X-CSRF-Token", csrf).type("form")
      .send("c_price_value=8700000&order_1=2&order_1=0&order_1=1&keep_1=2&keep_1=1");
    expect(edit.status).toBe(303);
    const { payload } = await loadPlan(id);
    expect(payload.choices["1"]).toEqual({ order: [2, 0, 1], keep: [2, 1], drop: [] });
    const page = (await agent.get(`/app/import/${id}?kind=changed`)).text;
    const values = [...page.matchAll(/name="keep_1" value="(\d)"( checked)?/g)].map((m) => [m[1], Boolean(m[2])]);
    expect(values).toEqual([["2", true], ["0", false], ["1", true]]);
    // Applying with the keep boxes in the page order saves the photos in that order.
    const apply = await agent.post(`/app/import/${id}/apply`).set("X-CSRF-Token", csrf).type("form").send("rows=1&picked_1=1&keep_1=2&keep_1=1");
    expect(apply.status).toBeLessThan(400);
    const [unit] = await h.query("SELECT id FROM listings WHERE code = 'HP-1' AND agency_id = $1", [h.AGENCY_A]);
    const saved = (await h.query("SELECT url FROM listing_images WHERE listing_id = $1 ORDER BY position", [unit.id])).map((r) => r.url);
    expect(saved).toEqual([photos[2], photos[1]]);
  });
});

describe("rules only (no AI)", () => {
  test("ai:false never calls AI: a post the parser cannot finish waits for the review; the page shows the switch with the credit cost", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const off = await agent.post("/app/import/match/plan").set("X-CSRF-Token", csrf).send({ filename: "chat.zip", ai: false, posts: POSTS });
    expect(off.status).toBe(200);
    expect(aiCalls).toBe(0);
    expect(off.body.ai).toBe(0);
    const { payload } = await loadPlan(off.body.id);
    expect(payload.items.some((i) => i.kind === "invalid")).toBe(true); // the compound is missing: fixed in the review's edit window
    const on = await plan(agent, csrf, POSTS);
    expect(on.body.ai).toBeGreaterThan(0);
    expect(aiCalls).toBeGreaterThan(0);
    const page = (await agent.get("/app/import")).text;
    expect(page).toMatch(/data-cp-ai[\s>]/);
    expect(page).toMatch(/data-ai-cost="\d+"/);
  });
});

describe("the import report (web and app logs in one summary)", () => {
  const ChatImportReport = require("../../services/chatImportReport");

  test("parser coverage, AI agreement per cell, review corrections, step timings and errors, code checks and app events are summarised", async () => {
    await h.insertListing({ code: "HP-1" });
    const { agent, csrf } = await signIn(h, "manager");
    // AI on: the parser misses the compound, AI fills it; where both read a cell they are compared.
    h.AI.respond((c) => (c.operation === "listing_extraction" ? { listing_type: "sale", property_type: "apartment", compound: "Hyde Park", area_value: 150, bedrooms: 3, price_value: 8600000 } : null));
    const id = (await plan(agent, csrf, POSTS)).body.id;
    // A step run in the browser, with and without an error, and a rules-only plan.
    await agent.post("/app/import/match/log").set("X-CSRF-Token", csrf).send({ steps: [{ step: "read_zip", ms: 1200, ok: true }, { step: "upload", ms: 9000, ok: false, error: "storage" }] });
    await agent.post("/app/import/match/plan").set("X-CSRF-Token", csrf).send({ filename: "x.zip", ai: false, posts: POSTS });
    await agent.post("/app/import/match/codes").set("X-CSRF-Token", csrf).send({ codes: ["HP-1", "HP-5"] });
    await agent.post(`/app/import/${id}/apply`).set("X-CSRF-Token", csrf).type("form").send("rows=1&rows=3");
    await new Promise((r) => setTimeout(r, 300)); // the logs are written without waiting
    const r = await ChatImportReport.report(h.pool, { days: 1 });
    expect(r.parser.posts).toBe(6);
    expect(r.parser.ai_used).toBeGreaterThan(0);
    expect(r.parser.rules_only).toBeGreaterThan(0);
    expect(r.parser.complete_pct).toBeGreaterThanOrEqual(0);
    expect(r.ai_vs_parser.agree + r.ai_vs_parser.differ).toBeGreaterThan(0);
    expect(r.plans.rules_only).toBe(1);
    expect(r.steps.map((s) => s.step).sort()).toEqual(expect.arrayContaining(["read_zip", "upload"]));
    expect(r.step_errors).toEqual([expect.objectContaining({ step: "upload", error_code: "storage", n: 1 })]);
    expect(r.codes[0]).toMatchObject({ channel: "web", calls: 1, codes: 2, update: 1, fresh: 1 });
    expect(r.review.applies).toBe(1);
  });
});
