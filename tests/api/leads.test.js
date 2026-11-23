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

test("merge and erase are for managers; erase needs the last 4 digits; draft and send answer", async () => {
  const a = (await call("broker", "post", "/leads", { phone1: "01012345678", name: "Sara", kind: "buyer", lawfulBasis: "client_request" })).body.lead;
  const b = (await call("broker", "post", "/leads", { phone1: "01099887766", name: "Sara H", kind: "buyer", lawfulBasis: "client_request" })).body.lead;
  expect((await call("broker", "post", `/leads/${a.ref}/merge`, { other: b.ref, confirm: "x" })).status).toBe(403);
  expect((await call("broker", "post", `/leads/${a.ref}/erase`, { confirm: "5678" })).status).toBe(403);
  expect((await call("broker", "post", `/leads/${a.ref}/send`, { code: "NOPE" })).status).toBe(422);
  await h.seedBroker("manager");
  expect((await call("manager", "post", `/leads/${a.ref}/erase`, { confirm: "0000" })).status).toBe(422);
  expect((await call("manager", "post", `/leads/${b.ref}/erase`, { confirm: "7766" })).status).toBe(200);
  expect((await call("manager", "get", `/leads/${b.ref}`)).status).toBe(404);
});

test("lead counts can be limited to one broker (managers)", async () => {
  await call("broker", "post", "/leads", { phone1: "01012345678", name: "Sara", kind: "buyer", lawfulBasis: "client_request" });
  const all = await call("broker", "get", "/leads/counts");
  expect(all.body.counts.all).toBe(1);
  await h.seedBroker("manager");
  const other = await call("manager", "get", `/leads/counts?broker=${h.BROKERS.colleague.id}`);
  expect(other.body.counts.all).toBe(0);
});
test("latest assignment filters counts and list to the same Cairo calendar month", async () => {
  const older = (await call("broker", "post", "/leads", { phone1: "01012345678", name: "Prior assignment" })).body.lead;
  await call("broker", "post", "/leads", { phone1: "01112345678", name: "Current assignment" });
  await h.pool.query(
    "UPDATE leads SET assigned_at = ((date_trunc('month', now() AT TIME ZONE 'Africa/Cairo') - interval '1 day') AT TIME ZONE 'Africa/Cairo') WHERE agency_id = $1 AND ref = $2",
    [h.BROKERS.broker.agency_id, Number(older.ref.slice(2))]
  );
  const listing = await call("broker", "get", "/leads?assigned=last");
  const counts = await call("broker", "get", "/leads/counts?assigned=last");
  expect(listing.body.items.map((lead) => lead.ref)).toEqual([older.ref]);
  expect(counts.body.counts.all).toBe(listing.body.total);
  expect(counts.body.counts.new).toBe(1);
  expect((await call("colleague", "get", "/leads?assigned=last")).body.total).toBe(0);
});

test("confirmed stage and note update atomically and a retry cannot append the note twice", async () => {
  const lead = (await call("broker", "post", "/leads", { phone1: "01112345678", name: "Previewed lead" })).body.lead;
  const url = `/leads/${lead.ref}/update`;
  const change = { version: lead.version, stage: "viewing", note: "Confirmed note" };
  expect((await call("colleague", "post", url, change)).status).toBe(404);
  expect((await call("broker", "post", url, { ...change, stage: "lost" })).status).toBe(422);
  expect((await call("broker", "get", `/leads/${lead.ref}`)).body.lead.stage).toBe("new");
  expect((await call("broker", "post", url, change)).body.lead.stage).toBe("viewing");
  expect((await call("broker", "post", url, change)).status).toBe(409);
  const details = (await call("broker", "get", `/leads/${lead.ref}`)).body;
  expect(details.timeline.filter((event) => event.text === change.note)).toHaveLength(1);
});

test("uncontacted, pending late first response, and overdue follow-up remain distinct queues", async () => {
  const created = await call("broker", "post", "/leads", { phone1: "01012345678", name: "Queue fixture" });
  const ref = created.body.lead.ref;
  expect((await call("broker", "get", "/leads?queue=uncontacted")).body.total).toBe(1);
  expect((await call("broker", "get", "/leads?queue=late-response")).body.total).toBe(0);
  await h.pool.query("UPDATE leads SET response_due_at = now() - interval '1 minute' WHERE agency_id = $1", [h.BROKERS.broker.agency_id]);
  expect((await call("broker", "get", "/leads/counts?queue=late-response")).body.counts.all).toBe(1);
  expect((await call("broker", "get", "/leads?queue=late-response")).body.items[0].ref).toBe(ref);
  expect((await call("broker", "get", "/leads?queue=overdue")).body.total).toBe(0);
  expect((await call("colleague", "get", "/leads?queue=late-response")).body.total).toBe(0);
});

test("matching uses a visible lead's saved requests and does not expose another broker's lead", async () => {
  const lead = (await call("broker", "post", "/leads", { phone1: "01012345678", name: "Matching fixture" })).body.lead;
  const actor = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.broker.id]))[0];
  await h.insertListing({ code: "MATCH-01", property_type: "apartment" });
  const service = require("../../services/leadRequests");
  expect((await service.saveRequest(h.pool, actor, lead.ref, { property_types: ["apartment"] })).ok).toBe(true);
  const matches = await call("broker", "get", `/leads/${lead.ref}/matches`);
  expect(matches.status).toBe(200);
  expect(matches.body.requests[0].items).toEqual([expect.objectContaining({ code: "MATCH-01" })]);
  const requestId = matches.body.requests[0].id;
  const adjusted = await call("broker", "get", `/leads/${lead.ref}/matches?requestId=${requestId}&price_max=1000`);
  expect(adjusted.status).toBe(200);
  expect(adjusted.body.requests[0].criteria.price_max).toBe(1000);
  expect(adjusted.body.requests[0].items).toEqual([]);
  expect((await call("broker", "get", `/leads/${lead.ref}/matches`)).body.requests[0].criteria.price_max).toBeNull();
  expect((await call("colleague", "get", `/leads/${lead.ref}/matches`)).status).toBe(404);
  const reverse = await call("broker", "get", "/units/MATCH-01/matching-leads");
  expect(reverse.status).toBe(200);
  expect(reverse.body.items).toEqual([expect.objectContaining({ ref: lead.ref })]);
  const another = await call("colleague", "get", "/units/MATCH-01/matching-leads");
  expect(another.body.items).toEqual([]);
  expect((await call("rival", "get", "/units/MATCH-01/matching-leads")).status).toBe(404);
});

test("follow-up completion is versioned and removes the lead from its follow-up queue", async () => {
  const lead = (await call("broker", "post", "/leads", { phone1: "01112345678", name: "Follow-up fixture" })).body.lead;
  const path = `/leads/${lead.ref}/follow-up`;
  const scheduled = await call("broker", "post", path, { at: new Date(Date.now() + 3600000).toISOString(), kind: "call" });
  expect(scheduled.status).toBe(200);
  expect((await call("broker", "post", path + "/complete", { version: lead.version })).status).toBe(409);
  const completed = await call("broker", "post", path + "/complete", { version: scheduled.body.lead.version });
  expect(completed.status).toBe(200);
  expect(completed.body.lead.followUpKind).toBeNull();
});

test("the missing-photo unit list uses the same filter for rows and status counts", async () => {
  const withImage = await h.insertListing({ code: "QA-WITH" });
  await h.insertListing({ code: "QA-WITHOUT" });
  await h.pool.query("INSERT INTO listing_images (agency_id, listing_id, url, position) VALUES ($1, $2, $3, 0)",
    [withImage.agency_id, withImage.id, "fixture/photo.jpg"]);
  const result = await call("broker", "get", "/units?missingPhotos=true");
  expect(result.status).toBe(200);
  expect(result.body.items.map((unit) => unit.code)).toEqual(["QA-WITHOUT"]);
  expect(result.body.counts.active).toBe(1);
});

test("sent offers filter on the selected lead, even when two leads share a name", async () => {
  await h.insertListing({ code: "OFFER-A" });
  await h.insertListing({ code: "OFFER-B" });
  const a = (await call("broker", "post", "/leads", { phone1: "01012345678", name: "Sara" })).body.lead;
  const b = (await call("broker", "post", "/leads", { phone1: "01112345678", name: "Sara" })).body.lead;
  expect((await call("broker", "post", `/leads/${a.ref}/send`, { code: "OFFER-A" })).status).toBe(200);
  expect((await call("broker", "post", `/leads/${b.ref}/send`, { code: "OFFER-B" })).status).toBe(200);
  const selected = await call("broker", "get", `/opened-links?leadRef=${b.ref}`);
  expect(selected.body.rows.map((row) => row.unit_code)).toEqual(["OFFER-B"]);
  expect((await call("colleague", "get", `/opened-links?leadRef=${b.ref}`)).status).toBe(404);
});
