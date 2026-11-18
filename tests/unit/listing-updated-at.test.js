// tests/unit/listing-updated-at.test.js — Migration 127: caching a flyer does not count as updating the unit (finding 69);
// any other change does, and an update that sets updated_at itself keeps its value.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");

jest.setTimeout(60000);
let h;
beforeAll(async () => { h = await createHarness(); });
afterAll(closeHarness);

const at = async () => (await h.query("SELECT updated_at FROM listings WHERE code = 'UA-1'"))[0].updated_at.toISOString();

test("a flyer cache write keeps updated_at; a real change moves it; an explicit value is kept", async () => {
  await h.insertListing({ code: "UA-1" });
  await h.query("UPDATE listings SET updated_at = '2026-01-01T00:00:00Z' WHERE code = 'UA-1'");
  expect(await at()).toBe("2026-01-01T00:00:00.000Z");
  await h.query(`UPDATE listings SET flyer_cache = '{"x":"y"}'::jsonb WHERE code = 'UA-1'`);
  expect(await at()).toBe("2026-01-01T00:00:00.000Z");
  await h.query("UPDATE listings SET bedrooms = 4 WHERE code = 'UA-1'");
  expect(await at()).not.toBe("2026-01-01T00:00:00.000Z");
});
