// tests/api/leads.test.js — The app's leads: own leads only, quick actions with version checks, errors that say what is wrong.
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

test("leads need a sign-in", async () => {
  expect((await request(h.app.app).get("/api/v1/leads")).status).toBe(401);
});

test("add a lead, list it, open it; a colleague never sees it", async () => {
  const add = await call("broker", "post", "/leads", { phone1: "01012345678", name: "Sara Hassan", kind: "buyer", lawfulBasis: "client_request" });
  expect(add.status).toBe(201);
  expect(add.body.lead.ref).toMatch(/^L-\d{4}$/);
  const ref = add.body.lead.ref;
  const list = await call("broker", "get", "/leads");
  expect(list.body.items.map((l) => l.ref)).toContain(ref);
  expect((await call("broker", "get", `/leads/${ref}`)).body.lead.name).toBe("Sara Hassan");
  expect((await call("colleague", "get", "/leads")).body.items.map((l) => l.ref)).not.toContain(ref);
  expect((await call("colleague", "get", `/leads/${ref}`)).status).toBe(404);
  expect((await call("colleague", "post", `/leads/${ref}/note`, { text: "x" })).status).toBe(404);
});

test("a bad phone is refused with a clear error", async () => {
  const r = await call("broker", "post", "/leads", { phone1: "12", name: "X" });
  expect(r.status).toBe(422);
  expect(r.body.error).toBeTruthy();
});

test("called, stage, follow-up and note change the lead; a stale version gets a 409 with the latest", async () => {
  const ref = (await call("broker", "post", "/leads", { phone1: "01112345678", name: "Omar", lawfulBasis: "client_request" })).body.lead.ref;
  const called = await call("broker", "post", `/leads/${ref}/contacted`, {});
  expect(called.status).toBe(200);
  const v = called.body.lead.version;
  const stage = await call("broker", "post", `/leads/${ref}/stage`, { stage: "interested", version: v });
  expect(stage.body.lead.stage).toBe("interested");
  const stale = await call("broker", "post", `/leads/${ref}/stage`, { stage: "viewing", version: v });
  expect(stale.status).toBe(409);
  expect(stale.body.lead.stage).toBe("interested");
  expect((await call("broker", "post", `/leads/${ref}/stage`, { stage: "lost" })).status).toBe(422);
  const at = new Date(Date.now() + 3600 * 1000).toISOString();
  const fu = await call("broker", "post", `/leads/${ref}/follow-up`, { at, kind: "viewing" });
  expect(fu.body).toMatchObject({ lead: { followUpKind: "viewing" } });
  expect((await call("broker", "post", `/leads/${ref}/follow-up`, { at: new Date(Date.now() - 3600 * 1000).toISOString() })).status).toBe(422);
  expect((await call("broker", "post", `/leads/${ref}/note`, { text: "  " })).status).toBe(422);
  expect((await call("broker", "post", `/leads/${ref}/note`, { text: "Wants 3 bedrooms" })).status).toBe(200);
  const t = await call("broker", "get", `/leads/${ref}`);
  expect(t.body.timeline.length).toBeGreaterThan(2);
});

test("extract reads a pasted message into a lead form and never saves", async () => {
  const r = await call("broker", "post", "/leads/extract", { message: "عايز شقة في التجمع 01012345678" });
  expect(r.status).toBe(200);
  expect(r.body.phones).toContain("01012345678");
  expect((await call("broker", "get", "/leads")).body.total).toBe(0);
  expect((await call("broker", "post", "/leads/extract", {})).status).toBe(400);
});
