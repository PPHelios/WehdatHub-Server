// tests/web/search-status.test.js — Web search shows Available first, with a Sold and an Archived switch for the same
// search (each with its count); sold and archived cards carry a badge and, for whoever may edit, "Mark available again".
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Search = require("../../services/search");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  const base = { broker_id: h.BROKERS.broker.id, property_type: "apartment", compound: "Hyde Park" };
  await h.insertListing({ ...base, code: "AV-1" });
  await h.insertListing({ ...base, code: "AV-2" });
  await h.insertListing({ ...base, code: "SO-1", status: "sold" });
  await h.insertListing({ ...base, code: "AR-1", status: "archived" });
  await h.insertListing({ ...base, code: "AR-2", status: "archived" });
  await h.insertListing({ ...base, code: "AR-3", status: "archived", property_type: "villa" });
});
afterAll(closeHarness);

const codesOn = (text) => [...text.matchAll(/data-code="([^"]+)"/g)].map((m) => m[1]).sort();

test("Available by default; Sold and Archived switch to the same search with their own counts", async () => {
  const a = await signIn(h, "admin");
  const first = (await a.agent.get("/app/search?lang=en&type=apartment")).text;
  expect(codesOn(first)).toEqual(["AV-1", "AV-2"]);
  expect(first).toMatch(/data-status="active"[^>]*aria-current="page">Available \(2\)/);
  expect(first).toMatch(/data-status="sold"[^>]*>Sold \(1\)/);
  expect(first).toMatch(/data-status="archived"[^>]*>Archived \(2\)/);

  const soldHref = first.match(/href="([^"]+)" data-status="sold"/)[1].replace(/&amp;/g, "&");
  const sold = (await a.agent.get(`${soldHref}&lang=en`)).text;
  expect(codesOn(sold)).toEqual(["SO-1"]);
  expect(sold).toMatch(/data-status="sold"[^>]*aria-current="page">Sold \(1\)/);
  expect(sold).toMatch(/data-status-badge>Sold</);
  expect(sold).toMatch(/data-mark-available/);

  const archivedHref = first.match(/href="([^"]+)" data-status="archived"/)[1].replace(/&amp;/g, "&");
  const archived = (await a.agent.get(`${archivedHref}&lang=en`)).text;
  expect(codesOn(archived)).toEqual(["AR-1", "AR-2"]); // the archived villa is another type
});

test("Mark available again puts a sold unit back among the available ones", async () => {
  const a = await signIn(h, "admin");
  const r = await a.agent.post("/app/units/bulk").type("form").send({ _csrf: a.csrf, code: "SO-1", action: "available" });
  expect(r.status).toBe(200);
  const first = (await a.agent.get("/app/search?lang=en&type=apartment")).text;
  expect(codesOn(first)).toEqual(["AV-1", "AV-2", "SO-1"]);
});

test("a broker can't restore another broker's sold unit: no button; client search stays available-only", async () => {
  await h.insertListing({ broker_id: h.BROKERS.admin.id, code: "SO-X", status: "sold", property_type: "apartment", compound: "Hyde Park" });
  const b = await signIn(h, "broker");
  const first = (await b.agent.get("/app/search?lang=en&type=apartment")).text;
  const soldHref = first.match(/href="([^"]+)" data-status="sold"/)[1].replace(/&amp;/g, "&");
  const sold = (await b.agent.get(`${soldHref}&lang=en`)).text;
  expect(codesOn(sold)).toEqual(["SO-1", "SO-X"]);
  // Their own unit has the button; the other broker's does not.
  expect((sold.match(/data-mark-available/g) || []).length).toBe(1);
});

test("the service: the match sweep's default stays available-only, and the status is validated", async () => {
  const filters = { property_types: ["apartment"] };
  expect((await Search.runSearch(h.pool, h.AGENCY_A, { filters }, {})).rows.map((r) => r.code).sort()).toEqual(["AV-1", "AV-2"]);
  expect((await Search.runSearch(h.pool, h.AGENCY_A, { filters }, { status: "sold" })).rows.map((r) => r.code)).toEqual(["SO-1"]);
  expect((await Search.runSearch(h.pool, h.AGENCY_A, { filters }, { status: "nonsense" })).rows).toHaveLength(2);
  expect(await Search.countByStatus(h.pool, h.AGENCY_A, { filters }, "archived")).toBe(2);
  expect(await Search.countByStatus(h.pool, h.AGENCY_A, { filters }, "deleted")).toBe(0);
});
