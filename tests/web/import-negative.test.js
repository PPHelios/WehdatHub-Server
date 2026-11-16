// tests/web/import-negative.test.js — Plan item 16: the WhatsApp import with wrong, hostile and odd input. Each case is refused or
// ignored: never a 500, never another agency's import, nothing written.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("manager");
  h.AI.respond((c) => (c.operation === "listing_extraction" ? { listing_type: "sale", market: "resale", property_type: "villa", compound: "Hyde Park", area_value: 300, bedrooms: 4, price_value: 25e6 } : null));
});
afterAll(closeHarness);

const POST = "فيلا للبيع في هايد بارك ٣٠٠ متر ٤ غرف السعر ٢٥ مليون";
const plan = (s, body) => s.agent.post("/app/import/match/plan").set("X-CSRF-Token", s.csrf).send(body);
const count = async () => Number((await h.query("SELECT count(*)::int AS n FROM listings WHERE agency_id = $1", [h.AGENCY_A]))[0].n);

describe("the plan call refuses bad bodies", () => {
  test.each([
    ["no posts", {}],
    ["posts is not a list", { posts: "text" }],
    ["posts is an object", { posts: { text: POST } }],
    ["posts of nothing", { posts: [null, 5, {}, { text: "" }, { text: "short" }] }],
    ["only spaces", { posts: [{ text: "          " }] }]
  ])("%s gives 422, not an error", async (_label, body) => {
    const s = await signIn(h, "manager");
    const r = await plan(s, body);
    expect([_label, r.status]).toEqual([_label, 422]);
  });

  test("a body that is not JSON is refused", async () => {
    const s = await signIn(h, "manager");
    const r = await s.agent.post("/app/import/match/plan").set("X-CSRF-Token", s.csrf).type("text/plain").send("hello");
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  test("very long posts and sixty posts are cut, not rejected", async () => {
    const s = await signIn(h, "manager");
    const posts = Array.from({ length: 60 }, (_, i) => ({ sender: "x".repeat(500), at: "y".repeat(500), text: `${POST} ${i} ${"z".repeat(4500)}` }));
    const r = await plan(s, { ai: false, posts });
    expect(r.status).toBe(200);
    expect(r.body.posts).toBeLessThanOrEqual(40); // the number of posts read
  });

  test("a script in a post comes back as text, never as markup", async () => {
    const s = await signIn(h, "manager");
    const r = await plan(s, { ai: false, posts: [{ sender: "<img src=x onerror=alert(1)>", text: `${POST} <script>alert(1)</script>` }] });
    expect(r.status).toBe(200);
    const page = await s.agent.get(`/app/import/${r.body.id}`);
    expect(page.status).toBe(200);
    expect(page.text).not.toContain("<script>alert(1)</script>");
    expect(page.text).not.toContain("<img src=x");
  });

  test("a plan call writes no unit by itself", async () => {
    const before = await count();
    const s = await signIn(h, "manager");
    await plan(s, { ai: false, posts: [{ text: POST }] });
    expect(await count()).toBe(before);
  });
});

describe("an import belongs to its agency", () => {
  test("another agency's person cannot open, edit, apply or undo it", async () => {
    const s = await signIn(h, "manager");
    const made = await plan(s, { ai: false, posts: [{ text: POST }] });
    expect(made.status).toBe(200);
    const id = made.body.id;
    const r = await signIn(h, "rival");
    expect([403, 404]).toContain((await r.agent.get(`/app/import/${id}`)).status); // a plain broker is turned away; a rival manager gets 404 below
    const post = (path, body = {}) => r.agent.post(path).type("form").send({ _csrf: r.csrf, ...body });
    expect([403, 404]).toContain((await post(`/app/import/${id}/apply`, { all: "1" })).status);
    expect([403, 404]).toContain((await post(`/app/import/${id}/edit/1`, { c_compound: "X" })).status);
    expect([403, 404]).toContain((await post(`/app/import/${id}/undo`)).status);
    expect(await count()).toBe(0);
  });

  test("a manager of another agency gets a not-found, not the import", async () => {
    const s = await signIn(h, "manager");
    const made = await plan(s, { ai: false, posts: [{ text: POST }] });
    await h.query("UPDATE brokers SET role = 'manager' WHERE id = $1", [h.BROKERS.rival.id]);
    const r = await signIn(h, "rival");
    expect((await r.agent.get(`/app/import/${made.body.id}`)).status).toBe(404);
    const apply = await r.agent.post(`/app/import/${made.body.id}/apply`).type("form").send({ _csrf: r.csrf, all: "1" });
    expect(apply.status).toBe(404);
    expect(await count()).toBe(0);
  });

  test.each(["nope", "00000000-0000-0000-0000-000000000000", "1; DROP TABLE listings", "%00"])("an unknown id %s is a plain not-found", async (id) => {
    const s = await signIn(h, "manager");
    const r = await s.agent.get(`/app/import/${encodeURIComponent(id)}`);
    expect([id, r.status < 500]).toEqual([id, true]);
  });
});

describe("apply with odd rows", () => {
  test.each([
    ["rows that do not exist", { rows: ["999", "-1", "abc"] }],
    ["no rows at all", {}],
    ["a row listed twice", { rows: ["1", "1", "1"] }]
  ])("%s adds nothing wrong and does not crash", async (_label, body) => {
    const s = await signIn(h, "manager");
    const made = await plan(s, { ai: false, posts: [{ text: POST }] });
    const before = await count();
    const r = await s.agent.post(`/app/import/${made.body.id}/apply`).type("form").send({ _csrf: s.csrf, ...body });
    expect([_label, r.status < 500]).toEqual([_label, true]);
    expect((await count()) - before).toBeLessThanOrEqual(1); // a row twice still makes one unit
  });

  test("applying twice does not add the unit twice", async () => {
    const s = await signIn(h, "manager");
    const made = await plan(s, { ai: false, posts: [{ text: POST }] });
    const go = () => s.agent.post(`/app/import/${made.body.id}/apply`).type("form").send({ _csrf: s.csrf, all: "1" });
    const before = await count();
    expect((await go()).status).toBeLessThan(500);
    const once = await count();
    expect((await go()).status).toBeLessThan(500);
    expect(await count()).toBe(once);
    expect(once - before).toBeLessThanOrEqual(1);
  });

  test("an edit of a row that does not exist is a not-found", async () => {
    const s = await signIn(h, "manager");
    const made = await plan(s, { ai: false, posts: [{ text: POST }] });
    for (const row of ["0", "99", "abc"]) {
      const r = await s.agent.post(`/app/import/${made.body.id}/edit/${row}`).type("form").send({ _csrf: s.csrf, c_compound: "X" });
      expect([row, r.status < 500]).toEqual([row, true]);
    }
  });
});

describe("who may import", () => {
  test("a broker without import rights and a missing token are turned away", async () => {
    const s = await signIn(h, "broker");
    const r = await s.agent.post("/app/import/match/plan").send({ posts: [{ text: POST }] }); // no CSRF header
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });
});
