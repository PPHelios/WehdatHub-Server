// tests/web/portal-enquiries.test.js — Portal enquiries (Bayut, Dubizzle, Nawy): kept for managers, unit link, phone and
// assignment into a lead, an existing lead keeps its broker, the owner's switch, and who may see the page.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");
const Enq = require("../../services/portalEnquiries");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const sample = (name = "Khaled El-Sawy", no = "503956661") =>
  `Hi Kenzy Emad,\nYou have received a new enquiry on Bayut.\nEnquirer Details:\nName: ${name}\nProperty Link: https://www.bayut.eg/pm/${no}/2662e7a7-7689-4a1c-9803-42d7977cf71a`;

test("a manager's forwarded enquiry is kept with name, link and listing number; a repeat within a day is not kept twice; brokers can't", async () => {
  const admin = await row("admin");
  const broker = await row("broker");
  const first = await Enq.capture(h.pool, admin, sample());
  expect(first.outcome).toBe("created");
  expect(first.enquiry).toMatchObject({ portal: "Bayut", client_name: "Khaled El-Sawy", listing_no: "503956661", status: "new", phone_e164: null });
  expect(await Enq.capture(h.pool, admin, sample())).toMatchObject({ outcome: "repeat" });
  expect(await Enq.capture(h.pool, broker, sample("Other"))).toMatchObject({ outcome: "forbidden" });
  expect(await Enq.capture(h.pool, admin, "hello there")).toMatchObject({ outcome: "not_enquiry" });
  expect(await h.query("SELECT count(*)::int AS n FROM portal_enquiries")).toEqual([{ n: 1 }]);
  // Managers are alerted (the owner's switch is on by default).
  expect((await h.query("SELECT count(*)::int AS n FROM notifications WHERE dedupe_key LIKE 'portal:%'"))[0].n).toBeGreaterThan(0);
});

test("linking a listing number to a unit shows the unit; assigning adds the phone and makes a lead from the portal, with the unit in its notes", async () => {
  const admin = await row("admin");
  const broker = await row("broker");
  await h.insertListing({ code: "VIL-08", property_type: "villa" });
  const { enquiry } = await Enq.capture(h.pool, admin, sample());
  expect(await Enq.linkUnit(h.pool, admin, enquiry.id, "VIL-08")).toMatchObject({ outcome: "linked", code: "VIL-08" });
  expect((await Enq.list(h.pool, admin))[0]).toMatchObject({ unit_code: "VIL-08" });
  expect(await Enq.assign(h.pool, admin, enquiry.id, { phone: "bad", brokerId: broker.id })).toMatchObject({ error: "phone_invalid" });
  const done = await Enq.assign(h.pool, admin, enquiry.id, { phone: "01012345678", brokerId: broker.id });
  expect(done).toMatchObject({ outcome: "created" });
  const lead = (await h.query("SELECT * FROM leads WHERE phone_e164 = '+201012345678'"))[0];
  expect(lead).toMatchObject({ source: "Bayut", name: "Khaled El-Sawy", assigned_broker_id: broker.id });
  expect(lead.notes).toMatch(/Bayut enquiry: https:\/\/www\.bayut\.eg\/pm\/503956661/);
  expect(lead.notes).toMatch(/Unit: VIL-08/);
  expect(await Enq.assign(h.pool, admin, enquiry.id, { phone: "01012345678", brokerId: broker.id })).toMatchObject({ error: "already_assigned" });
});

test("an enquiry for a number that already has a lead merges into it and the lead keeps its broker", async () => {
  const admin = await row("admin");
  const broker = await row("broker");
  const colleague = await row("colleague");
  await Leads.captureLead(h.pool, broker, { phones: "01012345679", name: "Mona", source: "Facebook" }, { quiet: true });
  const { enquiry } = await Enq.capture(h.pool, admin, sample("Khaled"));
  const r = await Enq.assign(h.pool, admin, enquiry.id, { phone: "01012345679", brokerId: colleague.id });
  expect(r).toMatchObject({ outcome: "merged", keptBroker: true });
  const lead = (await h.query("SELECT * FROM leads WHERE phone_e164 = '+201012345679'"))[0];
  expect(lead).toMatchObject({ assigned_broker_id: broker.id, source: "Facebook", name: "Mona" });
  expect((await h.query("SELECT merged, status FROM portal_enquiries WHERE id = $1", [enquiry.id]))[0]).toMatchObject({ merged: true, status: "assigned" });
});

test("the owner's switch turns the alerts off for the agency; only the owner can change it; the page is for managers only", async () => {
  const admin = await row("admin");
  await h.seedBroker("owner"); // the agency owner is seeded on demand (keeps the Office plan's seats free)
  const owner = await row("owner");
  expect(await Enq.setAlerts(h.pool, admin, false)).toMatchObject({ error: "forbidden" });
  expect(await Enq.setAlerts(h.pool, owner, false)).toMatchObject({ outcome: "saved", on: false });
  await Enq.capture(h.pool, admin, sample("Silent"));
  expect((await h.query("SELECT count(*)::int AS n FROM notifications WHERE dedupe_key LIKE 'portal:%'"))[0].n).toBe(0);

  await h.seedBroker("manager");
  const { agent: brokerAgent } = await signIn(h, "broker");
  expect((await brokerAgent.get("/app/portal-enquiries")).status).toBe(403);
  const { agent, csrf } = await signIn(h, "admin");
  const page = await agent.get("/app/portal-enquiries");
  expect(page.status).toBe(200);
  expect(page.text).toMatch(/Silent/);
  expect(page.text).not.toMatch(/alerts for managers and the owner/i);
  expect((await agent.post("/app/portal-enquiries/alerts").set("X-CSRF-Token", csrf).type("form").send("on=1")).status).toBe(403);
});
