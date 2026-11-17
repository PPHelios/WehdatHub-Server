// tests/web/deal-status-flow.test.js — QA round 2 (item 31) through the deal page and the service: forward is open, going back
// is a manager's choice with a confirmation, and every reopen is in the audit log.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Deals = require("../../services/deals");
const Leads = require("../../services/leads");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
async function newDeal(status = "pending") {
  const admin = await row("admin");
  const lead = await Leads.captureLead(h.pool, admin, { phones: "01012345678", name: "Deal Client" });
  const r = await Deals.createDeal(h.pool, admin, { leadKey: lead.lead.ref, price: 3000000, mode: "pct", pct: 2, closingBrokerId: h.BROKERS.broker.id, status });
  expect(r.ok).toBe(true);
  return r.deal;
}
const statusOf = async (id) => (await h.query("SELECT status FROM deals WHERE id = $1", [id]))[0].status;

test("a broker moves their deal forward but cannot move it back", async () => {
  const deal = await newDeal();
  const broker = await row("broker");
  expect((await Deals.updateDeal(h.pool, broker, deal.id, { status: "signed" })).ok).toBe(true);
  expect((await Deals.updateDeal(h.pool, broker, deal.id, { status: "paid" })).ok).toBe(true);
  const back = await Deals.updateDeal(h.pool, broker, deal.id, { status: "pending" });
  expect(back.error).toBe("status_backwards");
  expect(await statusOf(deal.id)).toBe("paid");
});

test("a manager reopening a paid deal needs the confirmation, then it is done and audited", async () => {
  const deal = await newDeal("paid");
  const admin = await row("admin");
  const noTick = await Deals.updateDeal(h.pool, admin, deal.id, { status: "pending" });
  expect(noTick.error).toBe("confirm_reopen");
  expect(await statusOf(deal.id)).toBe("paid");
  const ok = await Deals.updateDeal(h.pool, admin, deal.id, { status: "pending", confirmReopen: true });
  expect(ok.ok).toBe(true);
  expect(await statusOf(deal.id)).toBe("pending");
  const audit = await h.query("SELECT payload FROM audit_logs WHERE action = 'deal_status_reopen'");
  expect(audit).toHaveLength(1);
  expect(audit[0].payload).toMatchObject({ from: "paid", to: "pending" });
});

test("the deal page asks for the tick and shows the sentence when it is missing", async () => {
  const deal = await newDeal("paid");
  const a = await signIn(h, "admin");
  const ref = `D-${String(deal.ref).padStart(4, "0")}`;
  const res = await a.agent.post(`/app/deals/${ref}`).type("form").send({ _csrf: a.csrf, status: "pending", version: deal.version });
  expect(res.status).toBe(422);
  expect(res.text).toMatch(/This moves the deal back|هيرجّع الصفقة لورا/);
  expect(res.text).toMatch(/name="confirm_reopen"/);
  expect(await statusOf(deal.id)).toBe("paid");
  const done = await a.agent.post(`/app/deals/${ref}`).type("form").send({ _csrf: a.csrf, status: "pending", confirm_reopen: "1", version: deal.version });
  expect(done.status).toBe(303);
  expect(await statusOf(deal.id)).toBe("pending");
});
