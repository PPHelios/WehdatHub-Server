// tests/api/portal-enquiries.test.js — The app's portal enquiry screen: read (saves nothing), capture + assign, repeat, managers only, and /leads/extract's portal flag.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");

jest.setTimeout(90000);

let h;
let tokens;
beforeEach(async () => {
  h = await createHarness();
  tokens = {};
});
afterAll(() => closeHarness());

async function token(who) {
  if (tokens[who]) return tokens[who];
  const b = h.BROKERS[who];
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  tokens[who] = (await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: b.phone, code })).body.token;
  return tokens[who];
}
const call = async (who, method, path, body) => {
  const r = request(h.app.app)[method](`/api/v1${path}`).set("Authorization", `Bearer ${await token(who)}`);
  return body ? r.send(body) : r;
};
const sample = (portal = "Dubizzle", name = "Khaled El-Sawy", no = "503956661") =>
  `Hi Kenzy Emad,\nYou have received a new enquiry on ${portal}.\nEnquirer Details:\nName: ${name}\nProperty Link: https://www.${portal.toLowerCase()}.eg/pm/${no}/2662e7a7-7689-4a1c-9803-42d7977cf71a`;
const count = async () => (await h.query("SELECT count(*)::int AS n FROM portal_enquiries"))[0].n;

test("read parses the message and saves nothing; other text is 422", async () => {
  const r = await call("admin", "post", "/portal-enquiries/read", { message: sample() });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ ok: true, portal: "Dubizzle", name: "Khaled El-Sawy", listingNo: "503956661" });
  expect(r.body.link).toMatch(/^https:\/\/www\.dubizzle\.eg/);
  expect(await count()).toBe(0);
  const no = await call("admin", "post", "/portal-enquiries/read", { message: "عايز شقة" });
  expect(no.status).toBe(422);
  expect(no.body.ok).toBe(false);
});

test("a broker (not a manager) gets 403 everywhere", async () => {
  expect((await call("broker", "post", "/portal-enquiries/read", { message: sample() })).status).toBe(403);
  expect((await call("broker", "post", "/portal-enquiries", { message: sample() })).status).toBe(403);
  expect((await call("broker", "get", "/portal-enquiries")).status).toBe(403);
  expect(await count()).toBe(0);
});

test("capture with phone and broker creates the lead; the same enquiry twice is deduped", async () => {
  const broker = h.BROKERS.broker;
  const first = await call("admin", "post", "/portal-enquiries", { message: sample(), phone: "01012345678", brokerId: broker.id });
  expect(first.status).toBe(201);
  expect(first.body).toMatchObject({ deduped: false, assigned: true });
  expect(first.body.leadRef).toMatch(/^L-/);
  const lead = (await h.query("SELECT * FROM leads WHERE phone_e164 = '+201012345678'"))[0];
  expect(lead).toMatchObject({ source: "Dubizzle", assigned_broker_id: broker.id });
  const again = await call("admin", "post", "/portal-enquiries", { message: sample() });
  expect(again.status).toBe(200);
  expect(again.body).toMatchObject({ deduped: true, id: first.body.id, assigned: false });
  expect(await count()).toBe(1);
});

test("capture alone keeps the enquiry open; bad phone and non-portal text are 422 and save nothing", async () => {
  const open = await call("admin", "post", "/portal-enquiries", { message: sample("Nawy") });
  expect(open.status).toBe(201);
  expect(open.body).toMatchObject({ assigned: false, leadRef: null });
  expect((await call("admin", "get", "/portal-enquiries")).body.items).toHaveLength(1);
  expect((await call("admin", "post", "/portal-enquiries", { message: sample("Nawy", "Other", "603956661"), phone: "bad", brokerId: h.BROKERS.broker.id })).status).toBe(422);
  expect((await call("admin", "post", "/portal-enquiries", { message: "hello" })).status).toBe(422);
  expect(await count()).toBe(1);
});

test("a broker from another agency is refused on assign", async () => {
  const r = await call("admin", "post", "/portal-enquiries", { message: sample(), phone: "01012345678", brokerId: "00000000-0000-4000-8000-000000000000" });
  expect(r.status).toBe(422);
  expect(r.body).toMatchObject({ assigned: false, error: "assignee" });
});

test("/leads/extract flags a portal enquiry for managers without the AI; other text keeps the old shape", async () => {
  for (const portal of ["Dubizzle", "Nawy"]) {
    const r = await call("admin", "post", "/leads/extract", { message: sample(portal) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ portal: true, enquiry: { portal, name: "Khaled El-Sawy", listingNo: "503956661" } });
    expect(r.body.phones).toBeUndefined();
  }
  const plain = await call("admin", "post", "/leads/extract", { message: "عايز شقة في التجمع 01012345678" });
  expect(plain.body.portal).toBeUndefined();
  expect(plain.body).toHaveProperty("phones");
  expect(plain.body).toHaveProperty("kind");
  // Non-managers keep the normal lead form.
  const brokerRes = await call("broker", "post", "/leads/extract", { message: sample() });
  expect(brokerRes.body.portal).toBeUndefined();
  expect(brokerRes.body).toHaveProperty("phones");
  expect(await count()).toBe(0);
});
