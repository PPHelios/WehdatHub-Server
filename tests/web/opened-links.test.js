// tests/web/opened-links.test.js — "Opened links" (/app/links): every unit link sent to a client in one page. A broker sees
// their own, a team lead theirs and their team's, managers and the owner all; data entry none. Filters, search by number or
// lead, 20 a page with the total, and a lead's name and number only where the lead itself is visible.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Share = require("../../lib/shareLinks");
const Leads = require("../../services/leads");
const OpenedLinks = require("../../services/openedLinks");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const rowsOn = (text) => [...text.matchAll(/<li class="card result" data-opened-link data-opens="(\d+)">[\s\S]*?<b dir="ltr">([^<]+)<\/b>/g)].map((m) => ({ opens: Number(m[1]), code: m[2] }));
const brokerRow = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const totalOn = (text) => Number((text.match(/data-total="(\d+)"/) || [])[1]);

async function linkFor(code, broker, { opens = 0, lead = null } = {}) {
  const l = await h.insertListing({ broker_id: broker.id, code, property_type: "apartment", compound: "Hyde Park" });
  const { token } = await Share.createShareLink(h.pool, broker, l, { channel: "whatsapp", lang: "ar", leadId: lead ? lead.id : null });
  if (opens) await h.query("UPDATE share_links SET open_count = $2, last_opened_at = now() WHERE listing_id = $1", [l.id, opens]);
  return { token, listing: l };
}

test("a broker sees only their own links; a manager sees the agency's", async () => {
  await linkFor("OL-1", h.BROKERS.broker);
  await linkFor("OL-2", h.BROKERS.colleague);
  const b = await signIn(h, "broker");
  expect(rowsOn((await b.agent.get("/app/links?lang=en")).text).map((x) => x.code)).toEqual(["OL-1"]);
  const a = await signIn(h, "admin");
  const all = (await a.agent.get("/app/links?lang=en")).text;
  expect(rowsOn(all).map((x) => x.code).sort()).toEqual(["OL-1", "OL-2"]);
  expect(totalOn(all)).toBe(2);
});

test("data entry sees no links; the menu offers the page to brokers and managers", async () => {
  await linkFor("OL-3", h.BROKERS.broker);
  await h.pool.query("UPDATE brokers SET role = 'data_entry' WHERE id = $1", [h.BROKERS.colleague.id]);
  const de = await signIn(h, "colleague");
  const r = await de.agent.get("/app/links");
  expect(r.status).toBe(303); // the data entry gate sends them to Units
  expect(r.headers.location).toBe("/app/units");
  expect(r.text).not.toMatch(/OL-3/);
  expect((await de.agent.get("/app/more?lang=en")).text).not.toMatch(/href="\/app\/links"/);
  const b = await signIn(h, "broker");
  expect((await b.agent.get("/app/more?lang=en")).text).toMatch(/href="\/app\/links"/);
});

test("filters: never opened, opened, and more than once; channel; unit code search", async () => {
  await linkFor("OF-1", h.BROKERS.broker, { opens: 0 });
  await linkFor("OF-2", h.BROKERS.broker, { opens: 1 });
  await linkFor("OF-3", h.BROKERS.broker, { opens: 4 });
  const b = await signIn(h, "broker");
  const get = async (qs) => rowsOn((await b.agent.get(`/app/links?lang=en&${qs}`)).text).map((x) => x.code).sort();
  expect(await get("status=never")).toEqual(["OF-1"]);
  expect(await get("status=opened")).toEqual(["OF-2", "OF-3"]);
  expect(await get("status=repeat")).toEqual(["OF-3"]);
  expect(await get("channel=web")).toEqual([]);
  expect(await get("channel=whatsapp")).toHaveLength(3);
  expect(await get("q=of-2")).toEqual(["OF-2"]);
});

test("search by client number finds the link sent to that lead; the lead is shown to whoever may see it", async () => {
  const lead = (await Leads.captureLead(h.pool, await brokerRow("broker"), { phones: "01055512345", name: "Mona Hassan" })).lead;
  await linkFor("ON-1", h.BROKERS.broker, { lead });
  await linkFor("ON-2", h.BROKERS.broker);
  const b = await signIn(h, "broker");
  const found = (await b.agent.get("/app/links?lang=en&q=01055512345")).text;
  expect(rowsOn(found).map((x) => x.code)).toEqual(["ON-1"]);
  expect(found).toMatch(/Mona Hassan/);
  const a = await signIn(h, "admin");
  expect((await a.agent.get("/app/links?lang=en&q=Mona")).text).toMatch(/Mona Hassan/);
});

test("a lead assigned to someone else is shown without its name or number", async () => {
  // The lead belongs to the colleague; the broker sent the link, so the link is theirs to see but the lead is not.
  const lead = (await Leads.captureLead(h.pool, await brokerRow("colleague"), { phones: "01077788899", name: "Other Client" })).lead;
  await linkFor("OH-1", h.BROKERS.broker, { lead });
  const b = await signIn(h, "broker");
  const page = (await b.agent.get("/app/links?lang=en")).text;
  expect(page).not.toMatch(/Other Client|01077788899/);
  expect(page).toMatch(/not visible to you/);
});

test("20 a page, with the total shown and Next", async () => {
  for (let i = 1; i <= 23; i++) await linkFor(`PG-${String(i).padStart(2, "0")}`, h.BROKERS.broker);
  const a = await signIn(h, "admin");
  const p1 = (await a.agent.get("/app/links?lang=en")).text;
  expect(totalOn(p1)).toBe(23);
  expect(rowsOn(p1)).toHaveLength(20);
  expect(p1).toMatch(/page 1 of 2/);
  const p2 = (await a.agent.get("/app/links?lang=en&page=1")).text;
  expect(rowsOn(p2)).toHaveLength(3);
});

test("a manager filters by broker and by team lead", async () => {
  await linkFor("TM-1", h.BROKERS.broker);
  await linkFor("TM-2", h.BROKERS.colleague);
  const byBroker = await OpenedLinks.list(h.pool, await brokerRow("admin"), { broker: h.BROKERS.colleague.id });
  expect(byBroker.rows.map((r) => r.unit_code)).toEqual(["TM-2"]);
  expect(byBroker.total).toBe(1);
  const a = await signIn(h, "admin");
  expect(rowsOn((await a.agent.get(`/app/links?lang=en&broker=${h.BROKERS.colleague.id}`)).text).map((x) => x.code)).toEqual(["TM-2"]);
});
