// tests/web/cross-agency.test.js — Agency A is refused everywhere in agency B (patch 4). Every page route in web/routes is
// requested as an agency A owner: without an id, and with every id, code and reference found in agency B's rows in each
// parameter slot. No answer may show anything marked as agency B's, and a page for one of B's records must not open.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const fs = require("fs");
const path = require("path");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");

jest.setTimeout(280000);

const MARK = "ZZMARKB";
let h;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

/** Every GET page path declared in web/routes (public share pages and static assets are not signed-in pages). */
function pagePaths() {
  const dir = path.join(__dirname, "../../web/routes");
  const out = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    for (const m of fs.readFileSync(path.join(dir, f), "utf8").matchAll(/web\.get\(\s*"([^"]+)"/g)) out.add(m[1]);
  }
  return [...out].filter((p) => !p.startsWith("/v/") && !p.includes("*") && !/^\/(login|logout)/.test(p)).sort();
}

/** Ids, codes and references of agency B's records, from every table that carries an agency_id. */
async function foreignKeys() {
  const tables = await h.query("SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'agency_id' AND table_name NOT IN ('audit_logs', 'error_events')");
  const values = new Set([h.AGENCY_B, h.BROKERS.rival.id, "ZZMARKB-1"]);
  for (const { table_name: t } of tables) {
    let rows = [];
    try {
      rows = await h.query(`SELECT * FROM "${t}" WHERE agency_id = $1 LIMIT 4`, [h.AGENCY_B]);
    } catch { /* a table without a readable shape is skipped */ }
    for (const r of rows) for (const k of ["id", "code", "ref", "token", "lead_ref", "listing_id"]) if (r[k] != null && /^[\w-]{2,64}$/.test(String(r[k]))) values.add(String(r[k]));
  }
  return [...values];
}

test("agency A cannot open or see anything of agency B through any page", async () => {
  await h.seedBroker("owner");
  const rival = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.rival.id]))[0];
  await h.insertListing({ code: `${MARK}-1`, agency_id: h.AGENCY_B, broker_id: h.BROKERS.rival.id, compound: `${MARK} Compound`, details: { owner_name: `${MARK} Owner`, owner_phone: "01077776666" } });
  await Leads.captureLead(h.pool, rival, { phones: "01099990000", name: `${MARK} Lead` });
  const keys = await foreignKeys();
  const { agent } = await signIn(h, "owner");

  // Positive control: the same kind of request for agency A's own record does open, so a refusal below means something.
  await h.insertListing({ code: "ZZMARKA-1", compound: "ZZMARKA Compound" });
  const own = await agent.get("/app/units/ZZMARKA-1").redirects(0);
  expect(own.status).toBe(200);
  expect(own.text).toContain("ZZMARKA");
  const theirs = await agent.get(`/app/units/${MARK}-1`).redirects(0);
  expect(theirs.status).not.toBe(200);

  const leaks = [];
  let requests = 0;
  for (const route of pagePaths()) {
    const slots = (route.match(/:\w+/g) || []);
    const targets = slots.length === 0 ? [route] : [];
    if (slots.length) {
      // Each slot takes each foreign key in turn; a slot beyond the first is filled with one other plausible key.
      for (const key of keys) {
        let n = 0;
        targets.push(route.replace(/:\w+/g, () => (n++ === 0 ? encodeURIComponent(key) : encodeURIComponent(keys[(keys.indexOf(key) + 1) % keys.length]))));
      }
    }
    for (const url of targets) {
      const res = await agent.get(`/app${url}`).redirects(0);
      requests++;
      const body = res.type && /json|text|html/.test(res.type) ? String(res.text || "") : "";
      if (body.includes(MARK) || body.includes("01077776666") || body.includes("01099990000")) leaks.push(`${res.status} ${url}: shows agency B data`);
      else if (slots.length && res.status === 200 && keys.includes(decodeURIComponent(url.split("/").filter(Boolean).pop() || "")) && !/not found|مش موجود|404/i.test(body) && url !== route) {
        // A 200 for one of B's own ids that is not a "not found" page is suspicious; the marker check above is the hard rule.
        if (/ZZ|rival/i.test(body)) leaks.push(`${res.status} ${url}: opens for agency B's record`);
      }
    }
  }
  expect(requests).toBeGreaterThan(60);
  expect(leaks).toEqual([]);
});
