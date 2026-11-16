// tests/api/chatRead.test.js — the app's WhatsApp import reads every post with the website's rules reader (no AI, no credits):
// the add-unit form's fields plus the mandatory ones still missing, by the same rules as the add/edit unit form.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");

jest.setTimeout(90000);

let h;
let aiCalls;
beforeEach(async () => {
  h = await createHarness();
  aiCalls = 0;
  h.AI.respond(() => {
    aiCalls++;
    return null;
  });
});
afterAll(() => closeHarness());

async function authFor(b) {
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const res = await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: b.phone, code });
  return { Authorization: `Bearer ${res.body.token}` };
}

test("POST /units/chat-read: fields in the form's names, dollar price kept in dollars, built-up area first, mandatory ones listed; AI never called", async () => {
  const auth = await authFor(h.BROKERS.broker);
  const posts = [
    "Code MIr46 Hyde Park villa for sale Area : land area 420m / build up 354m 3 bedrooms 3 bathrooms fully furnished price:5000$ 01012345678",
    "شقة للايجار 150م شهري 20 ألف / سنوي 200 ألف 2 غرف 01012345678",
    "Villa Hyde Park 354m price:9 million"
  ];
  const res = await request(h.app.app).post("/api/v1/units/chat-read").set(auth).send({ posts });
  expect(res.status).toBe(200);
  expect(res.body.posts).toHaveLength(3);
  const [a, b, c] = res.body.posts;
  expect(a.fields).toMatchObject({ property_type: "villa", area_value: "354", price_value: "5000", currency: "USD", furnishing: "furnished", bedrooms: "3", code: "MIR46" });
  expect(a.missing).not.toContain("owner_phone");
  expect(b.fields).toMatchObject({ listing_type: "rent", price_value: "20000", bedrooms: "2" });
  expect(c.missing).toEqual(expect.arrayContaining(["owner_phone", "listing_type"]));
  expect(aiCalls).toBe(0);
});

test("POST /units/chat-read needs a signed-in person", async () => {
  const res = await request(h.app.app).post("/api/v1/units/chat-read").send({ posts: ["x"] });
  expect(res.status).toBe(401);
});
