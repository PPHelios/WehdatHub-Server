// tests/web/chat-review-save.test.js — the WhatsApp (zip) import review: what Save writes. Units with errors, existing units with no
// change and units the person discarded are never written (and never get photos), even when the page sends them ticked.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const sharp = require("sharp");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("manager");
  h.Storage.reset();
});
afterAll(closeHarness);

const plan = (agent, csrf, posts) => agent.post("/app/import/match/plan").set("X-CSRF-Token", csrf).send({ filename: "chat.zip", posts });
const loadPlan = async (id) => (await h.query("SELECT payload, status, result FROM web_imports WHERE id = $1", [id]))[0];
const apply = (agent, csrf, id, body) => agent.post(`/app/import/${id}/apply`).set("X-CSRF-Token", csrf).type("form").send(body);
const discard = (agent, csrf, id, body) => agent.post(`/app/import/${id}/discard`).set("X-CSRF-Token", csrf).type("form").send(body);
const photo = async (agent, csrf, url) => {
  const buf = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 30, b: 90 } } }).jpeg().toBuffer();
  return agent.post(url).set("X-CSRF-Token", csrf).attach("photo", buf, { filename: "photo.jpg", contentType: "image/jpeg" });
};

// HP-1 exists at 8.5M: the first post says the same (the unit has empty notes/description), the second a new price, the third is missing its owner phone, the fourth is new.
const POSTS = [
  { sender: "Ali", at: "24/10/2026 10:15", text: "شقة للبيع كود HP-1 مساحة 150 متر 3 غرف السعر 8.5 مليون 01012345678" },
  { sender: "Ali", at: "24/10/2026 10:16", text: "شقة للبيع كود HP-2 مساحة 150 متر 3 غرف السعر 9 مليون 01012345678" },
  { sender: "Ali", at: "24/10/2026 10:17", text: "villa for sale Hyde Park 354m 3 bedrooms price:9 million" },
  { sender: "Ali", at: "24/10/2026 10:18", text: "شقة للبيع Hyde Park كود HP-7 مساحة 120 متر 2 غرف السعر 5 مليون 01012345678" }
];

async function seed() {
  // Both units have the owner phone but empty notes and description: the post's generated text alone must not make HP-1 "changed".
  await h.insertListing({ code: "HP-1", details: { owner_phone: "01012345678" } });
  await h.insertListing({ code: "HP-2", details: { owner_phone: "01012345678" } });
  const { agent, csrf } = await signIn(h, "manager");
  const res = await plan(agent, csrf, POSTS);
  const { payload } = await loadPlan(res.body.id);
  return { agent, csrf, id: res.body.id, kinds: Object.fromEntries(payload.items.map((i) => [i.row, i.kind])) };
}
const version = async (code) => (await h.query("SELECT version, price_value FROM listings WHERE code = $1 AND agency_id = $2", [code, h.AGENCY_A]))[0];

describe("what Save writes", () => {
  test("the plan reports each post's kind; an unchanged existing unit and an invalid post are listed, not saved, even when ticked", async () => {
    const { agent, csrf, id, kinds } = await seed();
    expect(kinds[1]).toBe("unchanged");
    expect(kinds[3]).toBe("invalid");
    const before = await version("HP-1");
    const res = await apply(agent, csrf, id, "rows=1&rows=3&picked_1=1");
    expect(res.status).toBeLessThan(400);
    const after = await version("HP-1");
    expect(after.version).toBe(before.version); // no update, no version bump
    expect((await h.query("SELECT 1 FROM listings WHERE agency_id = $1", [h.AGENCY_A])).length).toBe(2); // the invalid post made no unit
    const { result } = await loadPlan(id);
    expect(result.unchanged).toEqual(["HP-1"]);
    expect(result.blocked).toEqual(["row 3"]);
    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
  });

  test("same fields but empty notes/description: unchanged, nothing written; a different price: changed", async () => {
    const { kinds, id } = await seed();
    expect(kinds[1]).toBe("unchanged");
    expect(kinds[2]).toBe("changed");
    const { payload } = await loadPlan(id);
    expect(payload.items.find((i) => i.row === 1).changes).toEqual([]);
    const row = (await h.query("SELECT version, details FROM listings WHERE code = 'HP-1' AND agency_id = $1", [h.AGENCY_A]))[0];
    expect(row.details.notes).toBeUndefined();
  });

  test("a discarded unit is hidden, never written, can be restored, and the bulk discards pick errors / unchanged rows", async () => {
    const { agent, csrf, id, kinds } = await seed();
    expect(kinds[4]).toBe("new");
    // Discard the new unit (row 4): hidden from the page, listed in the bar, never created even when ticked.
    expect((await discard(agent, csrf, id, "row=4")).status).toBe(303);
    expect((await loadPlan(id)).payload.discarded).toEqual([4]);
    const page = (await agent.get(`/app/import/${id}`)).text;
    expect(page).not.toMatch(/name="rows" value="4"/);
    expect(page).toMatch(/data-discarded-bar/);
    expect(page).toMatch(/data-restore="4"/);
    await discard(agent, csrf, id, "scope=errors");
    const res = await apply(agent, csrf, id, "rows=4");
    expect(res.status).toBeLessThan(400);
    expect((await h.query("SELECT 1 FROM listings WHERE code = 'HP-7' AND agency_id = $1", [h.AGENCY_A])).length).toBe(0);
    expect((await loadPlan(id)).result.discarded).toEqual(["HP-7"]);
  });

  test("restore brings a discarded row back; discard errors / unchanged take only those rows", async () => {
    const { agent, csrf, id } = await seed();
    await discard(agent, csrf, id, "scope=errors");
    expect((await loadPlan(id)).payload.discarded).toEqual([3]);
    await discard(agent, csrf, id, "scope=unchanged");
    expect((await loadPlan(id)).payload.discarded).toEqual([1, 3]);
    await discard(agent, csrf, id, "on=0&row=3");
    expect((await loadPlan(id)).payload.discarded).toEqual([1]);
    await discard(agent, csrf, id, "on=0&scope=all");
    expect((await loadPlan(id)).payload.discarded).toEqual([]);
  });

  test("the review's defaults: new and changed ticked, a code clash not ticked, an invalid unit has a disabled box; the line above Save says what is skipped", async () => {
    const { agent, id, kinds } = await seed();
    const page = (await agent.get(`/app/import/${id}`)).text;
    const box = (row) => new RegExp(`<input type="checkbox" name="rows" value="${row}"( checked)?>`).exec(page);
    expect(box(4)?.[1]).toBeTruthy(); // new: on
    if (kinds[2] === "review") expect(box(2)?.[1]).toBeFalsy(); // same code, another unit: needs a choice first
    else expect(box(2)?.[1]).toBeTruthy(); // changed: on
    expect(box(1)).toBeNull(); // no change: no box
    expect(box(3)).toBeNull(); // errors: no box, a disabled one instead
    expect(page).toMatch(/data-card-kind="invalid"[\s\S]*?<input type="checkbox" disabled/);
    expect(page).toMatch(/data-save-summary[^>]*data-errors="1"[^>]*data-unchanged="1"/);
    expect(page).toMatch(/Will save|هيتحفظ/);
    expect(page).toMatch(/data-save-button/);
  });

  test("a photo sent for an unchanged unit or a discarded one is not stored", async () => {
    const { agent, csrf, id } = await seed();
    const unchanged = await photo(agent, csrf, `/app/import/match/p/${id}/photo/1`);
    expect(unchanged.body).toEqual({ skipped: true });
    await discard(agent, csrf, id, "row=4");
    expect((await photo(agent, csrf, `/app/import/match/p/${id}/photo/4`)).body).toEqual({ skipped: true });
    expect((await loadPlan(id)).payload.photos).toEqual({});
    const fine = await photo(agent, csrf, `/app/import/match/p/${id}/photo/2`);
    expect(fine.body.ok || fine.body.dup).toBeTruthy();
  });

  test("an error unit does not block Save: the button stays enabled, a ticked error row is skipped", async () => {
    const { agent, csrf, id } = await seed();
    const page = (await agent.get(`/app/import/${id}`)).text;
    expect(page).not.toMatch(/data-errors-left/);
    expect(page).not.toMatch(/<button type="submit" data-save-button disabled>/);
    const res = await apply(agent, csrf, id, "rows=3&rows=4");
    expect(res.status).toBeLessThan(400);
    expect((await h.query("SELECT 1 FROM listings WHERE code = 'HP-7' AND agency_id = $1", [h.AGENCY_A])).length).toBe(1);
    expect((await loadPlan(id)).result.blocked.length).toBe(1);
  });
});
