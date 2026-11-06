// tests/web/owner-review.test.js — Period tabs (Yesterday · 7 days · Month), the search review work queue and the managers'
// private-details request queue: figures, filters, paging, actions, and who may open them.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const { resetConfig } = require("../../config");
const Period = require("../../lib/period");
const Privacy = require("../../services/unitPrivacy");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(() => {
  delete process.env.OWNER_BROKER_IDS;
  resetConfig();
});
afterAll(closeHarness);

const asCrmOwner = () => {
  process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
  resetConfig();
};
const post = (s, path, body) => s.agent.post(path).type("form").send({ _csrf: s.csrf, ...body });
const FLAG = JSON.stringify({ zero: true, bad_ids: [], disagree: [], missed_ids: [] });
const seedFlagged = async (n, text = "villa") => {
  for (let i = 0; i < n; i++) {
    await h.query("INSERT INTO search_log (agency_id, channel, query_text, source, total, audit) VALUES ($1, 'web', $2, 'parser', 0, $3::jsonb)", [h.AGENCY_A, `${text} ${i}`, FLAG]);
  }
};

test("periods: yesterday is the whole previous Cairo day; 7 days and Month end now; anything else is 7 days", () => {
  const now = new Date("2026-11-06T09:00:00Z"); // 11:00 in Cairo (UTC+2)
  const y = Period.parse("yesterday", now);
  expect(y.to.getTime() - y.from.getTime()).toBe(24 * 3600 * 1000);
  expect(y.to.toISOString()).toBe("2026-11-05T22:00:00.000Z");
  expect(Period.parse("7d", now).to).toEqual(now);
  expect(Period.parse("month", now).from.toISOString()).toBe("2026-10-07T09:00:00.000Z");
  expect(Period.parse("nonsense", now).key).toBe("7d");
  expect(Period.change(12, 10)).toBe("+20%");
  expect(Period.change(3, 0)).toBe("new");
});

test("the search review shows the period tabs and figures, and only the CRM owner opens it", async () => {
  asCrmOwner();
  await seedFlagged(2);
  const owner = await signIn(h, "admin");
  const text = (await owner.agent.get("/app/owner/searches?lang=en")).text;
  for (const k of ["yesterday", "7d", "month"]) expect(text).toContain(`data-period="${k}"`);
  expect(text).toContain("data-summary");
  expect(text).toContain("data-howto");
  expect(text).toContain("data-last-checked");
  expect((await (await signIn(h, "broker")).agent.get("/app/owner/searches")).status).toBe(404);
});

test("nightly findings are paged, filtered by type and period, and handled with one tap", async () => {
  asCrmOwner();
  await seedFlagged(25);
  await h.query("INSERT INTO search_log (agency_id, channel, query_text, source, total, audit) VALUES ($1, 'web', 'old one', 'parser', 0, $2::jsonb)", [h.AGENCY_A, FLAG]);
  await h.query("UPDATE search_log SET created_at = now() - interval '20 days' WHERE query_text = 'old one'");
  const owner = await signIn(h, "admin");
  const first = (await owner.agent.get("/app/owner/searches?view=audit&period=7d&lang=en")).text;
  expect((first.match(/data-finding=/g) || []).length).toBe(20);
  expect(first).toContain("data-pager");
  expect(first).not.toContain("old one");
  const second = (await owner.agent.get("/app/owner/searches?view=audit&period=7d&page=2&lang=en")).text;
  expect((second.match(/data-finding=/g) || []).length).toBe(5);
  expect((await owner.agent.get("/app/owner/searches?view=audit&period=month&status=all&q=old&lang=en")).text).toContain("old one");
  expect((await owner.agent.get("/app/owner/searches?view=audit&period=7d&type=wrong&lang=en")).text).not.toContain("data-finding=");

  const id = (await h.query("SELECT id FROM search_log WHERE query_text = 'villa 0'"))[0].id;
  const done = await post(owner, `/app/owner/searches/audit/${id}`, { decision: "resolve", back: "https://evil.example/x" });
  expect(done.status).toBe(303);
  expect(done.headers.location).toBe("/app/owner/searches");
  expect((await h.query("SELECT audit_resolved_at FROM search_log WHERE id = $1", [id]))[0].audit_resolved_at).not.toBeNull();
  const open = (await owner.agent.get("/app/owner/searches?view=audit&period=7d&lang=en")).text;
  expect(open).not.toContain(`data-finding="${id}"`);
  expect((await owner.agent.get("/app/owner/searches?view=audit&period=7d&status=done&lang=en")).text).toContain(`data-finding="${id}"`);
});

test("the one-day filter keeps only what changed in the last 24 hours, and repeat offenders group the same search", async () => {
  asCrmOwner();
  await seedFlagged(1, "recent");
  await h.query("INSERT INTO search_log (agency_id, channel, query_text, source, total, audit, created_at) VALUES ($1, 'web', 'zzold', 'parser', 0, $2::jsonb, now() - interval '3 days')", [h.AGENCY_A, FLAG]);
  const owner = await signIn(h, "admin");
  const day = (await owner.agent.get("/app/owner/searches?view=audit&period=month&changed=1&lang=en")).text;
  expect(day).toContain("recent 0");
  expect(day).not.toContain("zzold");
  for (let i = 0; i < 3; i++) await h.query("INSERT INTO search_log (agency_id, channel, query_text, source, total, audit) VALUES ($1, 'web', 'Same Search', 'parser', 0, $2::jsonb)", [h.AGENCY_A, FLAG]);
  const rep = (await owner.agent.get("/app/owner/searches?view=repeat&period=7d&lang=en")).text;
  expect(rep).toContain("same search");
  expect(rep).toMatch(/data-repeat[\s\S]*<td>3<\/td>/);
  await post(owner, "/app/owner/searches/repeat", { text: "same search" });
  expect((await h.query("SELECT count(*)::int AS n FROM search_log WHERE query_text = 'Same Search' AND audit_resolved_at IS NULL"))[0].n).toBe(0);
});

test("a Wrong-search report is closed as fixed or ignored from the queue", async () => {
  asCrmOwner();
  await seedFlagged(1);
  const logId = (await h.query("SELECT id FROM search_log LIMIT 1"))[0].id;
  await h.query("INSERT INTO search_reports (search_log_id, agency_id, broker_id, note) VALUES ($1, $2, $3, 'wrong area')", [logId, h.AGENCY_A, h.BROKERS.broker.id]);
  const rid = (await h.query("SELECT id FROM search_reports"))[0].id;
  const owner = await signIn(h, "admin");
  expect((await owner.agent.get("/app/owner/searches?view=reports&lang=en")).text).toContain(`data-report="${rid}"`);
  await post(owner, `/app/owner/searches/reports/${rid}`, { decision: "fixed" });
  expect((await h.query("SELECT status FROM search_reports"))[0].status).toBe("fixed");
  expect((await owner.agent.get("/app/owner/searches?view=reports&lang=en")).text).not.toContain(`data-report="${rid}"`);
});

test("the owner page carries the period tabs and a link to the search review", async () => {
  asCrmOwner();
  const owner = await signIn(h, "admin");
  const text = (await owner.agent.get("/app/owner?period=yesterday&lang=en")).text;
  expect(text).toContain("data-owner-period");
  expect(text).toContain('data-period="yesterday"');
  expect(text).toContain("/app/owner/searches");
});

test("managers read every private-details request in one list and answer from it; brokers cannot open it", async () => {
  await h.seedBroker("manager");
  const unit = await h.insertListing({ code: "ACC-1", broker_id: h.BROKERS.colleague.id, details: { owner_name: "Mr Secret" } });
  const listing = (await h.query("SELECT * FROM listings WHERE code = 'ACC-1'"))[0];
  await Privacy.requestAccess(h.pool, h.BROKERS.broker, listing);
  const mgr = await signIn(h, "manager");
  const text = (await mgr.agent.get("/app/access-requests?lang=en")).text;
  for (const k of ["yesterday", "7d", "month"]) expect(text).toContain(`data-period="${k}"`);
  expect(text).toContain("ACC-1");
  expect(text).toContain("data-summary");
  const rid = (await h.query("SELECT id FROM unit_access_requests"))[0].id;
  expect((await (await signIn(h, "broker")).agent.get("/app/access-requests")).status).toBe(404);
  expect((await post(await signIn(h, "broker"), `/app/access-requests/${rid}`, { decision: "approve" })).status).toBe(404);

  const done = await post(mgr, `/app/access-requests/${rid}`, { decision: "approve", back: "/app/access-requests" });
  expect(done.status).toBe(303);
  expect((await h.query("SELECT status FROM unit_access_requests"))[0].status).toBe("approved");
  expect((await mgr.agent.get("/app/access-requests?lang=en")).text).not.toContain(`data-request="${rid}"`);
  expect((await mgr.agent.get("/app/access-requests?status=approved&lang=en")).text).toContain(`data-request="${rid}"`);
  expect(unit).toBeDefined();
});
