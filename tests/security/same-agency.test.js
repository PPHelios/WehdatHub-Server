// tests/security/same-agency.test.js — Inside one agency, a broker reaches only their own work (lib/authz.js): every app
// API write on a colleague's lead or unit is refused and changes nothing, and data entry reaches no lead or deal at all.
// The routes come from the modules (tests/security/routes.js), so a new lead or unit action is covered automatically.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");
const Leads = require("../../services/leads");
const Routes = require("./routes");

jest.setTimeout(600000);

let h;
let leadRef;
const CODE = "ZZCOL-1";
beforeAll(async () => {
  h = await createHarness();
  const colleague = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.colleague.id]))[0];
  await h.insertListing({ code: CODE, broker_id: h.BROKERS.colleague.id, compound: "ZZCOL Compound", details: { owner_name: "ZZCOL Owner", owner_phone: "01055554444" } });
  await Leads.captureLead(h.pool, colleague, { phones: "01066665555", name: "ZZCOL Lead" });
  const lead = (await h.query("SELECT ref, assigned_broker_id FROM leads WHERE agency_id = $1 ORDER BY created_at DESC LIMIT 1", [h.BROKERS.colleague.agency_id]))[0];
  expect(lead.assigned_broker_id).toBe(h.BROKERS.colleague.id);
  leadRef = `L-${String(lead.ref).padStart(4, "0")}`;
});
afterAll(closeHarness);

const api = () => request(h.app.app);
async function bearer(who) {
  const b = h.BROKERS[who];
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  return { Authorization: `Bearer ${(await api().post("/api/v1/auth/code/verify").send({ phone: b.phone, code })).body.token}` };
}
const snapshot = async () => ({
  // Any broker may make a unit's flyer to share it; the flyer is cached on the unit, so those columns are left out (updated_at stays: migration 127).
  unit: (await h.query("SELECT md5((to_jsonb(l) - 'flyer_url' - 'flyer_cache' - 'flyer_wa_media_id' - 'flyer_wa_media_at')::text) AS h FROM listings l WHERE code = $1", [CODE]))[0].h,
  lead: (await h.query("SELECT md5(l::text) AS h FROM leads l WHERE name = 'ZZCOL Lead'"))[0].h
});
const BODY = { stage: "won", note: "x", status: "sold", at: new Date(Date.now() + 864e5).toISOString(), kind: "call", lang: "en", to: null, brokerId: null, version: 1, digits: "5555", confirm: "5555", other: "L-0001", owner_name: "Hijack", area: "999", price: "1", tenantName: "x", startDate: "2026-01-01", rent: "1", months: "12", value: true, on: true };

async function tryAll(auth, filter, fill) {
  const ok = [];
  for (const r of Routes.apiRoutes().filter((x) => filter.test(x.path))) {
    const url = `/api/v1${fill(r.path)}`;
    const res = r.method === "GET" ? await api().get(url).set(auth) : await api()[r.method.toLowerCase()](url).set(auth).send(BODY);
    if (res.status < 300) ok.push(`${res.status} ${r.method} ${r.path}`);
  }
  return ok;
}

test("a broker cannot read or work a colleague's lead", async () => {
  const before = await snapshot();
  const ok = await tryAll(await bearer("broker"), /^\/leads\/:ref/, (p) => p.replace(":ref", leadRef));
  expect(ok).toEqual([]);
  expect((await snapshot()).lead).toBe(before.lead);
});

test("a broker cannot change a colleague's unit", async () => {
  const before = await snapshot();
  // Reading a unit of the agency is allowed (authz.canView); every write is not.
  const ok = (await tryAll(await bearer("broker"), /^\/units\/:code/, (p) => p.replace(":code", CODE))).filter((x) => !x.includes(" GET ") && !/access-request|share-link|flyer/.test(x));
  expect(ok).toEqual([]);
  expect((await snapshot()).unit).toBe(before.unit);
});

test("data entry reaches no lead, deal or viewing", async () => {
  await h.query("UPDATE brokers SET role = 'data_entry' WHERE id = $1", [h.BROKERS.broker.id]);
  try {
    const before = await snapshot();
    const ok = await tryAll(await bearer("broker"), /^\/(leads|deals|viewings|commissions|ask)(\/|$)/, (p) => p.replace(":ref", leadRef).replace(/:\w+/g, "x1"));
    expect(ok).toEqual([]);
    expect((await snapshot()).lead).toBe(before.lead);
  } finally {
    await h.query("UPDATE brokers SET role = 'broker' WHERE id = $1", [h.BROKERS.broker.id]);
  }
});
