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
