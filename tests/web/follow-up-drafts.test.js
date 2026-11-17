// tests/web/follow-up-drafts.test.js — Release B N2: after a call or viewing, the next WhatsApp message to the client
// is drafted from the lead's own record (name, request, notes, the call or viewing) in the broker's tone (their sample
// in Settings). On the bot it comes after "Called" / "Follow-up done" with Send on WhatsApp; on the lead page with a
// wa.me link to the client's number. A colleague's client can't be drafted for.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const FakeAI = require("../harness/fake-ai");
const Leads = require("../../services/leads");
const Drafts = require("../../services/followUpDrafts");
const D = require("../../domain/followUpDraft");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
  FakeAI.reset();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const to = (who, replies) => replies.filter((r) => r.to === h.BROKERS[who].phone);
const ids = (r) => (r.buttons || []).map((b) => b.id);

async function lead(who = "broker") {
  const l = (await Leads.captureLead(h.pool, await row(who), { phones: ["01012345678"], name: "Sara Ali" })).lead;
  await Leads.addNote(h.pool, await row(who), l.id, "liked the garden");
  return l;
}

test("rules: facts from the record only; the template fills name, request, viewing and sign-off, never a price or date", () => {
  const facts = D.factsOf({ lead: { name: "Sara Ali", kind: "buyer", stage: "contacted" }, events: [{ kind: "follow_up_done", data: { kind: "viewing", note: "unit BD-1" }, created_at: "2026-10-20T10:00:00Z" }], broker: { name: "Mona" }, agencyName: "Alpha" });
  expect(facts).toContain("2026-10-20 viewing done: unit BD-1");
  const lead = { name: "Sara Ali", kind: "buyer", stage: "contacted" };
  const ar = D.template({ lead, events: [{ kind: "contacted", data: {}, created_at: "2026-10-20T10:00:00Z" }], requests: [{ filters: {} }], broker: { name: "Mona" }, agencyName: "Alpha", requestLine: () => "شقة في التجمع" });
  expect(ar).toContain("أهلاً Sara");
  expect(ar).toContain("شكراً على مكالمتنا");
  expect(ar).toContain("شقة في التجمع");
  expect(ar).toContain("Mona - Alpha");
  const en = D.template({ lead, viewing: { code: "BD-1", compound: "Mivida" }, broker: { name: "Mona" }, lang: "en" });
  expect(en).toContain("Hi Sara,");
  expect(en).toContain("viewing of BD-1 in Mivida");
  expect(en).toContain("another viewing");
  expect(D.template({ lead: { name: "", stage: "lost" }, broker: {} })).toContain("أهلاً بحضرتك");
  expect(D.parse("nope")).toEqual({ error: "empty" });
});

test("drafts for own clients only, from a template; lead page shows it with a WhatsApp link; no AI call", async () => {
  const l = await lead();
  const out = await Drafts.draft(h.pool, await row("broker"), l.id);
  expect(out.text).toContain("أهلاً Sara");
  expect(out.wa).toContain("https://wa.me/201012345678?text=");
  expect((await Drafts.draft(h.pool, await row("colleague"), l.id)).error).toBe("not_found");
  expect(FakeAI.calls ? FakeAI.calls.length : 0).toBe(0);

  const { agent, csrf } = await signIn(h, "broker");
  const page = await agent.post("/app/leads/L-0001/draft").type("form").send({ _csrf: csrf });
  expect(page.status).toBe(200);
  expect(page.text).toContain("data-follow-up-draft");
  expect(page.text).toContain("Sara");
  expect(page.text).toContain("data-draft-send");
});

test("bot: Called offers ✍️ Draft message; the draft comes back for the client", async () => {
  await lead();
  const called = to("broker", await h.tap("broker", "ld:called:L-0001"))[0];
  expect(ids(called)).toContain("ld:draft:L-0001");
  const draft = to("broker", await h.tap("broker", "ld:draft:L-0001"));
  expect(draft.map((r) => r.text).join(" ")).toContain("Sara");
});
