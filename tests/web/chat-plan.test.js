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
  test("the parser reads the posts with rules only (AI is never asked), and the code from the post is used", async () => {
    await h.insertListing({ code: "HP-1" });
    await h.insertListing({ code: "HP-2" });
    const { agent, csrf } = await signIn(h, "manager");
    const res = await plan(agent, csrf, POSTS);
    expect(res.status).toBe(200);
    expect(res.body.posts).toBe(3);
    expect(aiCalls).toBe(0); // rules only: a post missing its compound waits for the review's edit window
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
  test("AI is never called, even when asked: a post the parser cannot finish waits for the review; the page has no AI switch", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const off = await agent.post("/app/import/match/plan").set("X-CSRF-Token", csrf).send({ filename: "chat.zip", ai: false, posts: POSTS });
    expect(off.status).toBe(200);
    expect(aiCalls).toBe(0);
    expect(off.body.ai).toBe(0);
    const { payload } = await loadPlan(off.body.id);
    expect(payload.items.some((i) => i.kind === "invalid")).toBe(true); // the compound is missing: fixed in the review's edit window
    const on = await agent.post("/app/import/match/plan").set("X-CSRF-Token", csrf).send({ filename: "chat.zip", ai: true, posts: POSTS });
    expect(on.body.ai).toBe(0);
    expect(aiCalls).toBe(0);
    const page = (await agent.get("/app/import")).text;
    expect(page).not.toMatch(/data-cp-ai[\s>]/);
    expect(page).not.toMatch(/data-ai-cost=/);
  });
});

describe("the import report (web and app logs in one summary)", () => {
  const ChatImportReport = require("../../services/chatImportReport");

  test("parser coverage, AI agreement per cell, review corrections, step timings and errors, code checks and app events are summarised", async () => {
    await h.insertListing({ code: "HP-1" });
    const { agent, csrf } = await signIn(h, "manager");
    // Rules only: the parser misses the compound, so those posts wait for the review.
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
    expect(r.parser.ai_used).toBe(0);
    expect(r.parser.rules_only).toBeGreaterThan(0);
    expect(r.parser.complete_pct).toBeGreaterThanOrEqual(0);
    expect(r.plans.rules_only).toBe(2);
    expect(r.steps.map((s) => s.step).sort()).toEqual(expect.arrayContaining(["read_zip", "upload"]));
    expect(r.step_errors).toEqual([expect.objectContaining({ step: "upload", error_code: "storage", n: 1 })]);
    expect(r.codes[0]).toMatchObject({ channel: "web", calls: 1, codes: 2, update: 1, fresh: 1 });
    expect(r.review.applies).toBe(1);
  });
});

describe("the Edit window is the standard unit form", () => {
  const UNFINISHED = [{ sender: "Ali", at: "24/10/2026 10:15", text: "Villa 354m 3 bedrooms price:5000$ fully furnished" }];

  test("the editor is made by the server (place box, sale/rent chips, finishing and furnishing dropdowns) and reads what the parser found", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const res = await agent.post("/app/import/match/editor").set("X-CSRF-Token", csrf).send({ text: UNFINISHED[0].text });
    expect(res.status).toBe(200);
    expect(res.body.html).toContain("data-importeditor");
    expect(res.body.html).toContain("data-ubox");
    expect(res.body.html).toContain('name="c_finishing"');
    expect(res.body.html).toMatch(/<option value="semi_furnished"/);
    expect(res.body.html).toMatch(/name="c_furnishing"[\s\S]*?<option value="furnished" selected/);
    expect(res.body.html).toMatch(/name="c_listing_type" value="sale"/);
  });

  test("edits made in the window go on top of the reading: summary, plan and a saved unit all use them", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const fields = { c_listing_type: "sale", c_property_type: "villa", compound: "Hyde Park", c_price_value: "9 مليون", c_area_value: "354", c_bedrooms: "3", c_finishing: "fully_finished", c_furnishing: "semi_furnished", c_owner_phone: "01012345678", feature: ["private_pool"] };
    const sum = await agent.post("/app/import/match/summary").set("X-CSRF-Token", csrf).send({ posts: [{ text: UNFINISHED[0].text, fields }] });
    expect(sum.body.posts[0].missing).toEqual([]);
    expect(sum.body.posts[0].cells).toMatchObject({ compound: "Hyde Park", price_value: "9 مليون", finishing: "fully_finished", furnishing: "semi_furnished", listing_type: "sale" });
    const res = await agent.post("/app/import/match/plan").set("X-CSRF-Token", csrf).send({ filename: "chat.zip", posts: [{ ...UNFINISHED[0], fields }] });
    expect(res.status).toBe(200);
    const { payload } = await loadPlan(res.body.id);
    const item = payload.items[0];
    expect(item.kind).toBe("new");
    expect(item.fields).toMatchObject({ compound: "Hyde Park", finishing: "fully_finished", furnishing: "semi_furnished", price_value: 9000000 });
    // The review page's Edit window is the same form; saving it with the place and a dropdown re-plans the unit.
    const page = (await agent.get(`/app/import/${res.body.id}`)).text;
    expect(page).toContain("data-unit-edit-form");
    expect(page).toContain("data-ubox");
    const edit = await agent.post(`/app/import/${res.body.id}/edit/1`).set("X-CSRF-Token", csrf).type("form")
      .send("compound=Hyde+Park&c_listing_type=rent&c_property_type=villa&c_price_value=90000&c_area_value=354&c_bedrooms=3&c_finishing=super_lux&c_furnishing=unfurnished&c_owner_phone=01012345678");
    expect(edit.status).toBe(303);
    const after = (await loadPlan(res.body.id)).payload.items[0];
    expect(after.fields).toMatchObject({ listing_type: "rent", finishing: "super_lux", furnishing: "unfurnished" });
  });

  test("a unit missing its sale/rent shows the field in red and has no checkbox until it is edited", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const res = await agent.post("/app/import/match/plan").set("X-CSRF-Token", csrf).send({ filename: "chat.zip", posts: [{ sender: "Ali", at: "x", text: "Villa Hyde Park 354m 3 bedrooms price:9 million" }] });
    const page = (await agent.get(`/app/import/${res.body.id}?kind=invalid`)).text;
    expect(page).toContain('data-card-kind="invalid"');
    expect(page).toMatch(/ie-block missing" data-field="listing_type"/);
    expect(page).not.toMatch(/name="rows" value="1"/);
  });
});

describe("a new compound or area from the Edit window", () => {
  test("a picked area becomes the unit's district, a new compound keeps its Arabic name and map link for the owner's approval", async () => {
    const [area] = await h.query("SELECT id, name_en FROM areas WHERE parent_id IS NULL AND status = 'approved' ORDER BY name_en LIMIT 1");
    expect(area).toBeTruthy();
    const { agent, csrf } = await signIn(h, "manager");
    const res = await agent.post("/app/import/match/plan").set("X-CSRF-Token", csrf).send({ filename: "chat.zip", posts: [{ sender: "Ali", at: "x", text: "villa for sale 354m 3 bedrooms price:9 million" }] });
    const form = `compound=Brand+New+Compound&compound_new=1&compound_ar=${encodeURIComponent("كمبوند جديد")}&compound_pin=${encodeURIComponent("https://maps.google.com/?q=1,2")}&area_id=${area.id}` +
      "&c_listing_type=sale&c_property_type=villa&c_price_value=9+million&c_area_value=354&c_bedrooms=3&c_owner_phone=01012345678";
    const edit = await agent.post(`/app/import/${res.body.id}/edit/1`).set("X-CSRF-Token", csrf).type("form").send(form);
    expect(edit.status).toBe(303);
    const { payload } = await loadPlan(res.body.id);
    expect(payload.rows[0].cells).toMatchObject({ compound: "Brand New Compound", district: area.name_en });
    expect(payload.newPlaces["1"]).toEqual({ nameAr: "كمبوند جديد", pin: "https://maps.google.com/?q=1,2" });
    const apply = await agent.post(`/app/import/${res.body.id}/apply`).set("X-CSRF-Token", csrf).type("form").send("rows=1");
    expect(apply.status).toBeLessThan(400);
    const [unit] = await h.query("SELECT compound, area_id FROM listings WHERE compound = 'Brand New Compound' AND agency_id = $1", [h.AGENCY_A]);
    expect(unit.area_id).toBe(area.id);
    const [pending] = await h.query("SELECT name_ar, pin_link FROM place_names WHERE status = 'pending' AND name_en ILIKE 'Brand New Compound'");
    expect(pending).toMatchObject({ name_ar: "كمبوند جديد", pin_link: "https://maps.google.com/?q=1,2" });
  });
});

describe("mandatory fields are flagged and a unit missing one is held back", () => {
  test("no owner phone: the unit is held back with the phone flagged on its card and in the Edit window; the preview lists it as missing", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const text = "villa for sale Hyde Park 354m 3 bedrooms price:9 million";
    const sum = await agent.post("/app/import/match/summary").set("X-CSRF-Token", csrf).send({ posts: [{ text }] });
    expect(sum.body.posts[0].missing).toContain("owner_phone");
    const res = await agent.post("/app/import/match/plan").set("X-CSRF-Token", csrf).send({ filename: "chat.zip", posts: [{ sender: "Ali", at: "x", text }] });
    const { payload } = await loadPlan(res.body.id);
    expect(payload.items[0]).toMatchObject({ kind: "invalid", needs: ["owner_phone"] });
    const page = (await agent.get(`/app/import/${res.body.id}?kind=invalid`)).text;
    expect(page).toMatch(/data-field="owner_phone"/);
    expect(page).toMatch(/uc-field missing" data-field="owner_phone"/);
    expect(page).toMatch(/ie-field missing req" data-field="owner_phone"/);
    expect(page).not.toMatch(/name="rows" value="1"/);
    // Typing the phone in the Edit window frees it.
    const edit = await agent.post(`/app/import/${res.body.id}/edit/1`).set("X-CSRF-Token", csrf).type("form").send("compound=Hyde+Park&c_listing_type=sale&c_property_type=villa&c_price_value=9+million&c_area_value=354&c_bedrooms=3&c_owner_phone=01012345678");
    expect(edit.status).toBe(303);
    expect((await loadPlan(res.body.id)).payload.items[0].kind).toBe("new");
  });

  test("the mandatory list is the add/edit unit rules: bedrooms for an apartment or a villa, not for a shop; an owner phone always", () => {
    const requiredMissing = (c) => require("../../services/imports").missingCells(c, "en");
    expect(requiredMissing({ listing_type: "sale", property_type: "villa", compound: "X", price_value: "9 million", area_value: "300", owner_phone: "01012345678" })).toEqual(["bedrooms"]);
    expect(requiredMissing({ listing_type: "rent", property_type: "shop", compound: "X", price_value: "20000", area_value: "50", owner_phone: "01012345678" })).toEqual([]);
    expect(requiredMissing({ listing_type: "sale", property_type: "villa", compound: "X", price_value: "9 million", area_value: "300", bedrooms: "3" })).toEqual(["owner_phone"]);
  });
});
