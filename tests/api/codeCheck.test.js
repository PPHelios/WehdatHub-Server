// tests/api/codeCheck.test.js — the app's one call for the codes of a WhatsApp chat: update, new or taken (never more than that)
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(() => closeHarness());

async function authFor(b) {
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const res = await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: b.phone, code });
  return { Authorization: `Bearer ${res.body.token}` };
}

test("POST /units/code-check: a unit of the person is an update, a free code is new, a private unit is only 'taken'", async () => {
  await h.insertListing({ code: "HP-1", broker_id: h.BROKERS.broker.id });
  await h.insertListing({ code: "HP-SECRET", is_private: true });
  await h.insertListing({ code: "RIV-1", agency_id: h.AGENCY_B, broker_id: h.BROKERS.rival.id });
  const auth = await authFor(h.BROKERS.broker);
  const res = await request(h.app.app).post("/api/v1/units/code-check").set(auth).send({ codes: ["hp-1", "HP-9", "HP-SECRET", "RIV-1"] });
  expect(res.status).toBe(200);
  expect(res.body.codes["hp-1"]).toMatchObject({ state: "update", code: "HP-1", photos: 0 });
  expect(res.body.codes["HP-9"]).toEqual({ state: "new" });
  expect(res.body.codes["HP-SECRET"]).toEqual({ state: "taken" });
  expect(res.body.codes["RIV-1"]).toEqual({ state: "new" }); // another agency's unit is never shown
  expect(res.body.max_photos).toBe(15);
  expect(typeof res.body.ai_cost).toBe("number");
});

test("POST /units/code-check: another broker's unit is taken (not theirs to change); no token is refused", async () => {
  await h.insertListing({ code: "HP-2", broker_id: h.BROKERS.colleague.id });
  const auth = await authFor(h.BROKERS.broker);
  const res = await request(h.app.app).post("/api/v1/units/code-check").set(auth).send({ codes: ["HP-2"] });
  expect(res.body.codes["HP-2"]).toEqual({ state: "taken" });
  expect((await request(h.app.app).post("/api/v1/units/code-check").send({ codes: ["HP-2"] })).status).toBe(401);
});
