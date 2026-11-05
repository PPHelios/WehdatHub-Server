// tests/web/link-recipients.test.js — Phase 2 link tracking: a link is sent to a number or a lead (or to no one), made from
// the website, the bot or a lead; each counted open is kept with its device class and a visitor hash (no address), so two
// devices show as "maybe forwarded". Links made before this change have no recipient and no open rows.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");
const Share = require("../../lib/shareLinks");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36";
const brokerRow = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];

test("the website sends a link to a typed number: stored, the WhatsApp button goes to that number", async () => {
  await h.insertListing({ broker_id: h.BROKERS.broker.id, code: "RC-1" });
  const b = await signIn(h, "broker");
  const r = await b.agent.post("/app/units/RC-1/share").type("form").send({ _csrf: b.csrf, lang: "ar", to: "01012345678", note: "ابنه بيدور على شقة" });
  expect(r.status).toBe(200);
  expect(r.text).toMatch(/https:\/\/wa\.me\/201012345678\?text=/);
  expect(await h.query("SELECT recipient_phone, source, note FROM share_links")).toEqual([{ recipient_phone: "201012345678", source: "web", note: "ابنه بيدور على شقة" }]);
});

test("a lead reference attaches the lead and its number; the lead is visible only where it may be", async () => {
  const lead = (await Leads.captureLead(h.pool, await brokerRow("broker"), { phones: "01055512345", name: "Mona" })).lead;
  await h.insertListing({ broker_id: h.BROKERS.broker.id, code: "RC-2" });
  const b = await signIn(h, "broker");
  const r = await b.agent.post("/app/units/RC-2/share").type("form").send({ _csrf: b.csrf, lang: "en", to: `L-${String(lead.ref).padStart(4, "0")}` });
  expect(r.status).toBe(200);
  expect(await h.query("SELECT recipient_phone, lead_id FROM share_links")).toEqual([{ recipient_phone: "201055512345", lead_id: lead.id }]);
  const other = await signIn(h, "colleague");
  const bad = await other.agent.post("/app/units/RC-2/share").type("form").send({ _csrf: other.csrf, lang: "en", to: `L-${String(lead.ref).padStart(4, "0")}` });
  expect(bad.status).toBe(400);
  expect(bad.text).toMatch(/No lead with that reference|العميل ده مش موجود/);
});

test("invalid text is refused; an empty recipient is allowed (no recipient)", async () => {
  await h.insertListing({ broker_id: h.BROKERS.broker.id, code: "RC-3" });
  const b = await signIn(h, "broker");
  const bad = await b.agent.post("/app/units/RC-3/share").type("form").send({ _csrf: b.csrf, lang: "ar", to: "12345" });
  expect(bad.status).toBe(400);
  expect(await h.query("SELECT count(*)::int AS n FROM share_links")).toEqual([{ n: 0 }]);
  const ok = await b.agent.post("/app/units/RC-3/share").type("form").send({ _csrf: b.csrf, lang: "ar", to: "" });
  expect(ok.status).toBe(200);
  expect(await h.query("SELECT recipient_phone FROM share_links")).toEqual([{ recipient_phone: null }]);
});

test("a bot client copy is labelled as from the bot, with no recipient", async () => {
  const l = await h.insertListing({ broker_id: h.BROKERS.broker.id, code: "RC-4" });
  const broker = await brokerRow("broker");
  await Share.clientCopyWithLink(h.pool, broker, { ...l, agency_id: h.AGENCY_A }, "ar", "نص");
  expect(await h.query("SELECT source, recipient_phone FROM share_links")).toEqual([{ source: "bot", recipient_phone: null }]);
});

test("each counted open is kept with its device class and a visitor hash, and no address", async () => {
  await h.insertListing({ broker_id: h.BROKERS.broker.id, code: "RC-5" });
  const b = await signIn(h, "broker");
  const made = await b.agent.post("/app/units/RC-5/share").type("form").send({ _csrf: b.csrf, lang: "en" });
  const url = made.text.match(/data-share-url>([^<]+)</)[1];
  const path = url.replace(/^https?:\/\/[^/]+/, "");
  await request(h.app.app).get(path).set("User-Agent", IPHONE).set("X-Forwarded-For", "197.1.2.3");
  await request(h.app.app).get(path).set("User-Agent", IPHONE).set("X-Forwarded-For", "197.1.2.3");
  const opens = await h.query("SELECT device, visitor FROM share_link_opens");
  expect(opens).toHaveLength(2);
  expect(opens[0].device).toBe("iphone");
  expect(opens[0].visitor).toMatch(/^[0-9a-f]{32}$/);
  expect(opens[0].visitor).toBe(opens[1].visitor);
  expect(JSON.stringify(await h.query("SELECT * FROM share_link_opens"))).not.toContain("197.1.2.3");
  // The same link opened from a second device: two visitors, so "maybe forwarded" shows to the manager.
  await request(h.app.app).get(path).set("User-Agent", ANDROID).set("X-Forwarded-For", "41.9.9.9");
  const a = await signIn(h, "admin");
  const page = (await a.agent.get("/app/links?lang=en")).text;
  expect(page).toMatch(/opened from 2 devices/);
  expect(page).toMatch(/data-devices="2"/);
});

test("the opened links page searches by the number the link was sent to, and filters by source", async () => {
  await h.insertListing({ broker_id: h.BROKERS.broker.id, code: "RC-6" });
  const b = await signIn(h, "broker");
  await b.agent.post("/app/units/RC-6/share").type("form").send({ _csrf: b.csrf, lang: "en", to: "01099887766" });
  const found = (await b.agent.get("/app/links?lang=en&q=01099887766")).text;
  expect(found).toMatch(/data-opened-link/);
  expect(found).toMatch(/201099887766|01099887766/);
  expect((await b.agent.get("/app/links?lang=en&q=01000000000")).text).not.toMatch(/data-opened-link/);
  expect((await b.agent.get("/app/links?lang=en&source=bot")).text).not.toMatch(/data-opened-link/);
  expect((await b.agent.get("/app/links?lang=en&source=web")).text).toMatch(/data-opened-link/);
});
