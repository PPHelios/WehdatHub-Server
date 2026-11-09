// tests/api/pr4.test.js — The app's team view and reassigning, Ask, photos of an existing unit and the flyer link.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const sharp = require("sharp");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");
const FakeAI = require("../harness/fake-ai");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  FakeAI.reset();
});
afterAll(() => closeHarness());

const api = () => request(h.app.app);
async function login(who) {
  const b = h.BROKERS[who];
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const res = await api().post("/api/v1/auth/code/verify").send({ phone: b.phone, code });
  return { Authorization: `Bearer ${res.body.token}` };
}
const png = () => sharp({ create: { width: 40, height: 30, channels: 3, background: "#336699" } }).jpeg().toBuffer();

test("team: a plain broker is refused, a team lead sees their team and can reassign inside it", async () => {
  expect((await api().get("/api/v1/team").set(await login("broker"))).status).toBe(403);
  await h.query("UPDATE brokers SET role = 'team_lead' WHERE id = $1", [h.BROKERS.broker.id]);
  await h.query("UPDATE brokers SET team_lead_id = $1 WHERE id = $2", [h.BROKERS.broker.id, h.BROKERS.colleague.id]);
  const lead = await login("broker");
  const made = await api().post("/api/v1/leads").set(lead).send({ phone1: "01011112222", name: "Lead One", kind: "buyer" });
  const ref = made.body.lead.ref;
  const team = await api().get("/api/v1/team").set(lead);
  expect(team.status).toBe(200);
  expect(team.body.items.map((m) => m.name).sort()).toEqual(["Broker One", "Broker Two"]);
  expect(team.body.items.find((m) => m.me).open).toBe(1);
  const moved = await api().post(`/api/v1/leads/${ref}/assign`).set(lead).send({ brokerId: h.BROKERS.colleague.id });
  expect(moved.status).toBe(200);
  expect(moved.body.lead.assigneeId).toBe(h.BROKERS.colleague.id);
  const theirs = await api().get(`/api/v1/leads?broker=${h.BROKERS.colleague.id}`).set(lead);
  expect(theirs.body.items.map((l) => l.ref)).toEqual([ref]);
  const mine = await api().get(`/api/v1/leads?broker=${h.BROKERS.broker.id}`).set(lead);
  expect(mine.body.items).toEqual([]);
  // outside the team: refused
  expect((await api().post(`/api/v1/leads/${ref}/assign`).set(lead).send({ brokerId: h.BROKERS.admin.id })).status).toBe(403);
});

test("ask answers from the assistant and refuses an empty question", async () => {
  FakeAI.respond(() => ({ answer: "Badya delivery is 2028.", found: true }));
  const auth = await login("broker");
  const out = await api().post("/api/v1/ask").set(auth).send({ question: "when is Badya delivery" });
  expect(out.status).toBe(200);
  expect(out.body.answer).toMatch(/2028/);
  expect(out.body.found).toBe(true);
  expect((await api().post("/api/v1/ask").set(auth).send({ question: "  " })).status).toBe(400);
});

test("photos of an existing unit: add, order and remove; a colleague cannot", async () => {
  await h.insertListing({ code: "A-1", compound: "Mivida" });
  const auth = await login("broker");
  const add = await api().post("/api/v1/units/A-1/photos").set(auth).attach("photos", await png(), { filename: "a.jpg", contentType: "image/jpeg" }).attach("photos", await png(), { filename: "b.jpg", contentType: "image/jpeg" });
  expect(add.status).toBe(200);
  expect(add.body.images).toHaveLength(2);
  const [first, second] = add.body.images;
  const swap = await api().post("/api/v1/units/A-1/photos").set(auth).send({ order: [second.id, first.id] });
  expect(swap.body.images.map((i) => i.id)).toEqual([second.id, first.id]);
  const gone = await api().post("/api/v1/units/A-1/photos").set(auth).send({ remove: [second.id] });
  expect(gone.body.images.map((i) => i.id)).toEqual([first.id]);
  expect((await api().post("/api/v1/units/A-1/photos").set(await login("colleague")).send({})).status).toBe(403);
});

test("flyer link: made once, then the same link; a stranger gets 404", async () => {
  await h.insertListing({ code: "A-1", compound: "Mivida", price_value: 9e6, bedrooms: 3 });
  const auth = await login("broker");
  const one = await api().post("/api/v1/units/A-1/flyer").set(auth).send({});
  expect(one.status).toBe(200);
  expect(one.body.url).toMatch(/^https?:|^\//);
  const two = await api().post("/api/v1/units/A-1/flyer").set(auth).send({});
  expect(two.body.url).toBe(one.body.url);
  expect((await api().post("/api/v1/units/A-1/flyer").set(await login("rival")).send({})).status).toBe(404);
});
