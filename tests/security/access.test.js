// tests/security/access.test.js — Who can reach what, on the website and the app API alike (QA round 3, step 4).
// 1. Nobody signed out reaches a signed-in route.
// 2. Agency A's owner (the widest role) cannot read or change anything of agency B through any app API route or any
//    website write: every id, code and reference of B's rows is tried in every slot and body field, B's rows are
//    fingerprinted before and after, and no answer may carry B's marker.
// Routes come from the modules (tests/security/routes.js), so a new route is covered without editing this file.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const fs = require("fs");
const path = require("path");
const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const WebAuth = require("../../lib/webAuth");
const Leads = require("../../services/leads");
const Routes = require("./routes");

jest.setTimeout(900000);

const MARK = "ZZMARKB";
const B_PHONE = "01077776666";
const B_LEAD_PHONE = "01099990000";
let h;
beforeAll(async () => {
  h = await createHarness();
  await h.seedBroker("owner");
  const rival = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.rival.id]))[0];
  await h.insertListing({ code: `${MARK}-1`, agency_id: h.AGENCY_B, broker_id: h.BROKERS.rival.id, compound: `${MARK} Compound`, details: { owner_name: `${MARK} Owner`, owner_phone: B_PHONE } });
  await Leads.captureLead(h.pool, rival, { phones: B_LEAD_PHONE, name: `${MARK} Lead` });
});
afterAll(closeHarness);

const api = () => request(h.app.app);
async function bearer(who) {
  const b = h.BROKERS[who];
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const t = (await api().post("/api/v1/auth/code/verify").send({ phone: b.phone, code })).body.token;
  return { Authorization: `Bearer ${t}` };
}

/** Tables that hold agency data (logs and counters are written by any request, so they are left out). */
async function agencyTables() {
  const rows = await h.query("SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'agency_id'");
  return rows.map((r) => r.table_name).filter((t) => !/log|event|rate|usage|metric|audit|error|failure|slow|request_ids|read_caps|counter|quota|session|token|cache/i.test(t)).sort();
}

/** One fingerprint per table of agency B's rows. */
async function fingerprint(tables) {
  const out = {};
  for (const t of tables) {
    try {
      out[t] = (await h.query(`SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t}" x WHERE agency_id = $1`, [h.AGENCY_B]))[0];
    } catch { /* unreadable shape: skipped */ }
  }
  return out;
}

/** Ids, codes and references of agency B's rows. */
async function foreignKeys(tables) {
  const values = new Set([h.AGENCY_B, h.BROKERS.rival.id, `${MARK}-1`]);
  for (const t of tables) {
    let rows = [];
    try { rows = await h.query(`SELECT * FROM "${t}" WHERE agency_id = $1 LIMIT 3`, [h.AGENCY_B]); } catch { /* skipped */ }
    for (const r of rows) for (const k of ["id", "code", "ref", "token", "listing_id", "lead_id", "owner_id"]) if (r[k] != null && /^[\w-]{1,64}$/.test(String(r[k]))) values.add(String(r[k]));
  }
  return [...values];
}

const BODY_KEYS = ["id", "code", "ref", "leadRef", "lead_ref", "lead", "unit", "unitCode", "unit_code", "listingId", "listing_id", "leadId", "lead_id", "ownerId", "owner_id", "brokerId", "broker_id", "teamLeadId", "team_lead_id", "assignee", "to", "projectId", "project_id", "other"];
const bodyWith = (key) => Object.fromEntries(BODY_KEYS.map((k) => [k, key]));
const fill = (route, key) => route.replace(/:\w+/g, encodeURIComponent(key));
const leaks = (res) => {
  const body = typeof res.text === "string" ? res.text : "";
  // B's names carry "ZZMARKB " (with a space); a bare "ZZMARKB-1" may just be the typed code echoed back.
  return body.includes(`${MARK} `) || body.includes(B_PHONE) || body.includes(B_LEAD_PHONE);
};
const changedTables = (before, after) => Object.keys(before).filter((t) => JSON.stringify(before[t]) !== JSON.stringify(after[t]));

test("the route lists match what api/index.js mounts", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../api/index.js"), "utf8");
  const mounted = [...src.matchAll(/require\("\.\/(\w+)"\)\.register\(priv/g)].map((m) => m[1]).sort();
  expect([...Routes.API_MODULES].sort()).toEqual(mounted);
  expect(Routes.apiRoutes().length).toBeGreaterThan(100);
  expect(Routes.webRoutes().length).toBeGreaterThan(200);
});

test("signed out: every app API route answers 401 and no website route opens", async () => {
  const open = [];
  for (const r of Routes.apiRoutes()) {
    const res = await api()[r.method.toLowerCase()](`/api/v1${fill(r.path, "x1")}`).send({});
    if (res.status !== 401) open.push(`${res.status} API ${r.method} ${r.path}`);
  }
  for (const r of Routes.webRoutes()) {
    const res = await api()[r.method.toLowerCase()](`/app${fill(r.path, "x1")}`).redirects(0).type("form").send({});
    if (res.status < 300) open.push(`${res.status} WEB ${r.method} ${r.path}`);
  }
  expect(open).toEqual([]);
});

test("agency A's owner reads and changes nothing of agency B through the app API", async () => {
  const tables = await agencyTables();
  const keys = await foreignKeys(tables);
  const before = await fingerprint(tables);
  const auth = await bearer("owner");
  // Positive control: A's own unit opens, so a refusal of B's means something.
  await h.insertListing({ code: "ZZMARKA-1", compound: "ZZMARKA Compound" });
  expect((await api().get("/api/v1/units/ZZMARKA-1").set(auth)).status).toBe(200);

  const found = [];
  const errors = [];
  let n = 0;
  let limited = 0;
  for (const r of Routes.apiRoutes()) {
    if (/^\/(auth|devices)\b/.test(r.path) || r.path === "/client-error") continue;
    const list = r.path.includes(":") ? keys : [keys[0]];
    for (const key of list) {
      const call = api()[r.method.toLowerCase()](`/api/v1${fill(r.path, key)}`).set(auth);
      const res = r.method === "GET" ? await call.query({ q: key, code: key, ref: key, id: key }) : await call.send(bodyWith(key));
      n++;
      if (res.status === 429) limited++;
      if (res.status >= 500) errors.push(`${res.status} ${r.method} ${r.path}`);
      if (leaks(res)) found.push(`${res.status} ${r.method} ${fill(r.path, key)}: shows agency B data`);
    }
  }
  expect(n).toBeGreaterThan(300);
  // A rate limit would hide a missing check: almost every request must reach its handler.
  expect(limited / n).toBeLessThan(0.05);
  expect(found).toEqual([]);
  // Another agency's id is a 'not found', never a server error.
  expect([...new Set(errors)]).toEqual([]);
  expect(changedTables(before, await fingerprint(tables))).toEqual([]);
});

test("agency A's owner changes nothing of agency B through any website write", async () => {
  const tables = await agencyTables();
  const keys = await foreignKeys(tables);
  const before = await fingerprint(tables);
  const { agent, csrf } = await signIn(h, "owner");
  const found = [];
  const errors = [];
  for (const r of Routes.webRoutes()) {
    if (r.method === "GET" || /^\/(logout|passkey)/.test(r.path)) continue;
    const list = r.path.includes(":") ? keys : [keys[0]];
    for (const key of list) {
      const res = await agent[r.method.toLowerCase()](`/app${fill(r.path, key)}`).set("X-CSRF-Token", csrf).redirects(0).type("form").send(bodyWith(key));
      if (res.status >= 500) errors.push(`${res.status} ${r.method} ${r.path}`);
      if (leaks(res)) found.push(`${res.status} ${r.method} ${fill(r.path, key)}: shows agency B data`);
    }
  }
  expect(found).toEqual([]);
  // Another agency's id is a 'not found', never a server error.
  expect([...new Set(errors)]).toEqual([]);
  expect(changedTables(before, await fingerprint(tables))).toEqual([]);
});
