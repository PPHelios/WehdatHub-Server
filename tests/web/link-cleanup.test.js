// tests/web/link-cleanup.test.js — Expired and revoked client links are removed with their open logs; erasing a client
// detaches their links from them and deletes the opens of those links. The unit links themselves stay.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const Share = require("../../lib/shareLinks");
const Leads = require("../../services/leads");
const Privacy = require("../../services/privacy");
const LinkCleanup = require("../../services/linkCleanup");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const brokerRow = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const DAY = 24 * 3600 * 1000;

async function makeLink(code, { lead = null, recipient = null } = {}) {
  const l = await h.insertListing({ broker_id: h.BROKERS.broker.id, code });
  const { token } = await Share.createShareLink(h.pool, await brokerRow("broker"), l, {
    channel: "web",
    lang: "ar",
    leadId: lead ? lead.id : null,
    recipient: recipient || (lead ? { phone: "201055512345", leadId: lead.id } : null),
    source: "web"
  });
  const hash = (await h.query("SELECT token_hash FROM share_links WHERE listing_id = $1", [l.id]))[0].token_hash;
  await h.query("INSERT INTO share_link_opens (token_hash, device, visitor) VALUES ($1, 'iphone', 'abc')", [hash]);
  return { token, hash, listing: l };
}

test("an expired link goes with its opens; a live one stays; a link revoked long ago goes, a recent revocation stays", async () => {
  const live = await makeLink("CL-1");
  const expired = await makeLink("CL-2");
  const revokedOld = await makeLink("CL-3");
  const revokedNew = await makeLink("CL-4");
  await h.query("UPDATE share_links SET expires_at = now() - interval '1 day' WHERE token_hash = $1", [expired.hash]);
  await h.query("UPDATE share_links SET revoked_at = now() - interval '40 days' WHERE token_hash = $1", [revokedOld.hash]);
  await h.query("UPDATE share_links SET revoked_at = now() - interval '2 days' WHERE token_hash = $1", [revokedNew.hash]);
  const out = await LinkCleanup.cleanup(h.pool);
  expect(out.links).toBe(2);
  const left = (await h.query("SELECT token_hash FROM share_links")).map((r) => r.token_hash).sort();
  expect(left).toEqual([live.hash, revokedNew.hash].sort());
  const opens = await h.query("SELECT token_hash FROM share_link_opens");
  expect(opens.map((r) => r.token_hash).sort()).toEqual([live.hash, revokedNew.hash].sort());
  // The unit itself is untouched.
  expect(await h.query("SELECT code FROM listings WHERE code = 'CL-2'")).toHaveLength(1);
});

test("erasing a client detaches their links and deletes the opens of those links; other links keep theirs", async () => {
  const lead = (await Leads.captureLead(h.pool, await brokerRow("broker"), { phones: "01055512345", name: "Erase Me" })).lead;
  const mine = await makeLink("ER-1", { lead });
  const other = await makeLink("ER-2");
  const admin = await brokerRow("admin");
  const suffix = "2345";
  const out = await Privacy.eraseLead(h.pool, admin, lead.id, { confirm: suffix });
  expect(out.ok).toBe(true);
  const link = (await h.query("SELECT lead_id, recipient_phone FROM share_links WHERE token_hash = $1", [mine.hash]))[0];
  expect(link).toEqual({ lead_id: null, recipient_phone: null });
  expect(await h.query("SELECT 1 FROM share_link_opens WHERE token_hash = $1", [mine.hash])).toEqual([]);
  expect(await h.query("SELECT 1 FROM share_link_opens WHERE token_hash = $1", [other.hash])).toHaveLength(1);
  expect(await h.query("SELECT 1 FROM listings WHERE code = 'ER-1'")).toHaveLength(1);
});
