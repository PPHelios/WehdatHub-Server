// tests/api/appInbox.test.js — The app's notification inbox (list, read, delete, counts) and the client's message language on a lead.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");
const Leads = require("../../services/leads");
const Card = require("../../domain/leadCard");

jest.setTimeout(90000);

let h;
let tok;
beforeAll(async () => {
  h = await createHarness();
  const b = h.BROKERS.broker;
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  tok = (await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: b.phone, code })).body.token;
});
afterAll(() => closeHarness());

const get = (p) => request(h.app.app).get(`/api/v1${p}`).set("Authorization", `Bearer ${tok}`);
const post = (p) => request(h.app.app).post(`/api/v1${p}`).set("Authorization", `Bearer ${tok}`);

test("inbox: list newest first, unread count, read one, delete one, read all, delete all; only the broker's own", async () => {
  const b = h.BROKERS.broker;
  const other = h.BROKERS.colleague;
  const ins = (broker, n) => h.query("INSERT INTO notifications (agency_id, broker_id, kind, title, body, channel, status, dedupe_key) VALUES ($1, $2, 'match', $3, 'b', 'inbox', 'sent', $4) RETURNING id", [broker.agency_id, broker.id, n, `t:${broker.id}:${n}`]);
  const [a] = await ins(b, "A");
  const [c] = await ins(b, "B");
  const [theirs] = await ins(other, "theirs");
  const list = await get("/notifications");
  expect(list.status).toBe(200);
  expect(list.body.items.map((i) => i.title)).toEqual(["B", "A"]);
  expect(list.body.unread).toBe(2);
  expect((await get("/notifications/unread-count")).body.unread).toBe(2);
  expect((await post(`/notifications/${a.id}/read`)).body.unread).toBe(1);
  expect((await post(`/notifications/${c.id}/delete`)).body.unread).toBe(0);
  expect((await get("/notifications")).body.items.map((i) => i.title)).toEqual(["A"]);
  expect((await post(`/notifications/${theirs.id}/delete`)).status).toBe(404);
  await ins(b, "C");
  expect((await post("/notifications/read-all")).body.unread).toBe(0);
  expect((await post("/notifications/delete-all")).body.ok).toBe(true);
  expect((await get("/notifications")).body.items).toEqual([]);
  expect((await h.query("SELECT dismissed_at FROM notifications WHERE id = $1", [theirs.id]))[0].dismissed_at).toBeNull();
});

test("a lead carries the client's message language; the broker can set and clear it", async () => {
  const broker = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.broker.id]))[0];
  const lead = (await Leads.captureLead(h.pool, broker, { phones: ["01055556666"], name: "Lang Test" })).lead;
  const ref = Card.refLabel(lead.ref);
  expect((await get(`/leads/${ref}`)).body.lead.lang).toBeNull();
  const en = await post(`/leads/${ref}/lang`).send({ lang: "en" });
  expect(en.status).toBe(200);
  expect(en.body.lead.lang).toBe("en");
  expect((await get(`/leads/${ref}`)).body.lead.lang).toBe("en");
  expect((await post(`/leads/${ref}/lang`).send({ lang: null })).body.lead.lang).toBeNull();
  expect((await post("/leads/L-999999/lang").send({ lang: "ar" })).status).toBe(404);
});

test("Ask results for the app: grouped by project, area is a minimum, filters can be dropped", async () => {
  const admin = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];
  const Catalogue = require("../../services/catalogue");
  await Catalogue.saveProject(h.pool, admin, { name: "Obour Alpha", city: "العبور", notes: "شقة 110 م² بسعر 2,900,000 مقدم 10%" });
  await Catalogue.saveProject(h.pool, admin, { name: "Obour Beta", city: "العبور", notes: "شقة 150 م² بسعر 4,000,000 مقدم 10%" });
  const q = "شقة في العبور مساحة أكتر من 120م";
  const r = await get("/ask/results").query({ q });
  expect(r.status).toBe(200);
  expect(r.body.total_projects).toBe(1);
  expect(r.body.projects[0].name).toBe("Obour Beta");
  expect(r.body.projects[0].offers.map((o) => o.area)).toEqual([150]);
  expect(r.body.chips.map((c) => c.key)).toEqual(expect.arrayContaining(["area", "place"]));
  const d = await get("/ask/results").query({ q, drop: "area" });
  expect(d.body.total_projects).toBe(2);
  expect((await get("/ask/results")).status).toBe(400);
});
