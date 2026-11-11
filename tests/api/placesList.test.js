// tests/api/placesList.test.js — The app downloads the approved place list once and re-checks it by version.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");
const Suggest = require("../../services/placeSuggest");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  Suggest.resetCache();
});
afterAll(() => closeHarness());

const api = () => request(h.app.app);
async function token() {
  const b = h.BROKERS.broker;
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  return (await api().post("/api/v1/auth/code/verify").send({ phone: b.phone, code })).body.token;
}

test("the list needs a sign-in", async () => {
  expect((await api().get("/api/v1/places/list")).status).toBe(401);
});

test("the list has a version, and the same version answers unchanged", async () => {
  const t = await token();
  const first = await api().get("/api/v1/places/list").set({ Authorization: `Bearer ${t}` });
  expect(first.status).toBe(200);
  expect(first.body.version).toMatch(/^[0-9a-f]{16}$/);
  expect(Array.isArray(first.body.places)).toBe(true);
  expect(Array.isArray(first.body.areas)).toBe(true);
  const again = await api().get("/api/v1/places/list").query({ since: first.body.version }).set({ Authorization: `Bearer ${t}` });
  expect(again.body).toEqual({ version: first.body.version, unchanged: true });
  const other = await api().get("/api/v1/places/list").query({ since: "old" }).set({ Authorization: `Bearer ${t}` });
  expect(other.body.places).toBeDefined();
});
