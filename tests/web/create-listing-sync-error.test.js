// tests/web/create-listing-sync-error.test.js — An error after the unit is inserted (the owner link) must reach the log as
// itself, not as 'savepoint "listing_insert" does not exist'.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const Store = require("../../lib/listingStore");
const Owners = require("../../services/unitOwners");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(() => jest.restoreAllMocks());
afterAll(closeHarness);

test("createListing shows the real owner-sync error", async () => {
  // The insert names every column, so each NOT NULL column with a default gets that default's value here.
  const defs = await h.query("SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'listings' AND is_nullable = 'NO' AND column_default IS NOT NULL");
  const filled = {};
  for (const d of defs) filled[d.column_name] = (await h.query(`SELECT ${d.column_default} AS v`))[0].v;
  jest.spyOn(require("../../services/compoundResolve"), "normalize").mockImplementation(async (db, f) => ({ ...filled, ...f }));
  jest.spyOn(Owners, "syncFromListing").mockRejectedValue(new Error("owner sync boom"));
  const broker = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.broker.id]))[0];
  const client = await h.pool.connect();
  try {
    await client.query("BEGIN");
    await expect(
      Store.createListing(client, broker, { fields: { listing_type: "sale", property_type: "apartment", price_value: 5e6, area_value: 100, details: { owner_name: "Mr Owner", owner_phone: "01012345678" } }, code: null, lang: "en" })
    ).rejects.toThrow("owner sync boom");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
});
