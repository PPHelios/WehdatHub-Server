// tests/web/global-projects.test.js — The global project library: the owner publishes, a manager copies once, and the
// card says "not stated" when finishing or furnishing is empty.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const GP = require("../../services/globalProjects");
const Describe = require("../../domain/describe");

jest.setTimeout(90000);
let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await closeHarness(h);
});

test("owner publishes, a manager copies once, and the copy is the agency's own", async () => {
  expect((await GP.syncFile(h.pool)).added).toBeGreaterThan(20);
  expect((await GP.syncFile(h.pool)).added).toBe(0);
  const agencyId = h.BROKERS.manager.agency_id;
  expect(await GP.list(h.pool, { agencyId })).toHaveLength(0);
  const [g] = await h.query("SELECT id FROM global_projects WHERE lower(name) = 'aliva'");
  await GP.setPublished(h.pool, g.id, true);
  expect(await GP.use(h.pool, h.BROKERS.broker, g.id)).toEqual({ error: "forbidden" });
  const first = await GP.use(h.pool, h.BROKERS.manager, g.id);
  expect(first.ok).toBe(true);
  expect(first.project.global_id).toBe(g.id);
  expect(await GP.use(h.pool, h.BROKERS.manager, g.id)).toEqual({ error: "duplicate" });
  expect((await GP.list(h.pool, { agencyId }))[0].used).toBe(true);
});

test("the card says not stated when finishing or furnishing is empty", () => {
  const lines = Describe.factLines({ property_type: "apartment", listing_type: "rent", details: {} }, "en", { markMissing: true }).join("\n");
  expect(lines).toMatch(/Finishing ❔ not stated/);
  expect(lines).toMatch(/Furnishing ❔ not stated/);
  expect(Describe.factLines({ property_type: "apartment", listing_type: "rent", details: {} }, "en").join("\n")).not.toMatch(/not stated/);
});

const Config = require("../../config");
// The CRM owner is the broker whose id is in OWNER_BROKER_IDS; the test sets it for the calls that need it.
async function asCrmOwner(id, fn) {
  process.env.OWNER_BROKER_IDS = id;
  Config.resetConfig();
  try {
    return await fn();
  } finally {
    delete process.env.OWNER_BROKER_IDS;
    Config.resetConfig();
  }
}

test("the CRM owner adds and edits; an edit never publishes; everyone else is refused", async () => {
  await asCrmOwner(h.BROKERS.admin.id, async () => {
    const made = await GP.create(h.pool, h.BROKERS.admin, { name: "Test Hills", developer: "Dev", area_acres: "12.5" });
    expect(made.ok).toBe(true);
    expect((await h.query("SELECT published FROM global_projects WHERE id = $1", [made.id]))[0].published).toBe(false);
    await GP.setPublished(h.pool, made.id, true);
    expect(await GP.update(h.pool, h.BROKERS.admin, made.id, { name: "Test Hills 2", facts: "x" })).toEqual({ ok: true });
    expect((await h.query("SELECT name, published FROM global_projects WHERE id = $1", [made.id]))[0]).toEqual({ name: "Test Hills 2", published: true });
    expect(await GP.create(h.pool, h.BROKERS.broker, { name: "No" })).toEqual({ error: "forbidden" });
    expect(await GP.update(h.pool, h.BROKERS.manager, made.id, { name: "x" })).toEqual({ error: "forbidden" });
    expect(await GP.create(h.pool, h.BROKERS.admin, { name: "  " })).toEqual({ error: "empty" });
    expect(await GP.create(h.pool, h.BROKERS.admin, { name: "Y", area_acres: "abc" })).toEqual({ error: "area" });
  });
});

test("pages hold 20 entries; search finds names and suggests them; agencies see only published entries", async () => {
  await GP.syncFile(h.pool);
  await h.query("UPDATE global_projects SET published = true");
  const total = (await h.query("SELECT count(*)::int AS n FROM global_projects"))[0].n;
  const agencyId = h.BROKERS.manager.agency_id;
  const first = await GP.listPage(h.pool, { agencyId, page: 1 });
  expect(first.items).toHaveLength(Math.min(GP.PAGE_SIZE, total));
  expect(first.total).toBe(total);
  expect(first.pages).toBe(Math.ceil(total / GP.PAGE_SIZE));
  const past = await GP.listPage(h.pool, { agencyId, page: 999 });
  expect(past.page).toBe(past.pages);
  const found = await GP.listPage(h.pool, { agencyId, q: "ALI" });
  expect(found.items.some((g) => g.name.toLowerCase() === "aliva")).toBe(true);
  expect(found.suggestions.some((n) => n.toLowerCase() === "aliva")).toBe(true);
  await h.query("UPDATE global_projects SET published = false WHERE lower(name) = 'aliva'");
  expect((await GP.listPage(h.pool, { agencyId, q: "aliva" })).items).toHaveLength(0);
  expect((await GP.listPage(h.pool, { agencyId: null, q: "aliva" })).items).toHaveLength(1);
});
