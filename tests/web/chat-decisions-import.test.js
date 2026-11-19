// tests/web/chat-decisions-import.test.js — The website's WhatsApp import remembers what the agency decided about each post of a chat
// (saved, discarded, unchanged) through services/chatDecisions.js (the same service as the app's /units/chat-decisions), and offers
// the app's date range (7/30/90 days, since the last import, all, custom since/until).
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Decisions = require("../../services/chatDecisions");
const FP = require("../../domain/chatFingerprint");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("manager");
  h.Storage.reset();
});
afterAll(closeHarness);

const CHAT = FP.chatFingerprint("WhatsApp Chat with Brokers.txt", "24/10/2026 10:15");
const plan = (agent, csrf, posts, chat_fp = CHAT) => agent.post("/app/import/match/plan").set("X-CSRF-Token", csrf).send({ filename: "chat.zip", chat_fp, posts });
const loadPlan = async (id) => (await h.query("SELECT payload, status, result FROM web_imports WHERE id = $1", [id]))[0];
const form = (agent, csrf, path, body) => agent.post(path).set("X-CSRF-Token", csrf).type("form").send(body);
const decisions = async () => (await Decisions.list(h.pool, h.AGENCY_A, CHAT)).decisions;

// HP-1 exists unchanged; HP-2 exists and the post changes its price; HP-7 is new.
const POSTS = [
  { sender: "Ali", at: "24/10/2026 10:15", text: "شقة للبيع كود HP-1 مساحة 150 متر 3 غرف السعر 8.5 مليون 01012345678" },
  { sender: "Ali", at: "24/10/2026 10:16", text: "شقة للبيع كود HP-2 مساحة 150 متر 3 غرف السعر 8.8 مليون 01012345678" },
  { sender: "Ali", at: "24/10/2026 10:18", text: "شقة للبيع Hyde Park كود HP-7 مساحة 120 متر 2 غرف السعر 5 مليون 01012345678" }
];
const pfp = (i) => FP.postFingerprint(POSTS[i].sender, POSTS[i].at, POSTS[i].text);

async function seed() {
  await h.insertListing({ code: "HP-1", details: { owner_phone: "01012345678" } });
  await h.insertListing({ code: "HP-2", details: { owner_phone: "01012345678" } });
  const { agent, csrf } = await signIn(h, "manager");
  const res = await plan(agent, csrf, POSTS);
  return { agent, csrf, id: res.body.id, res };
}

test("the plan carries the chat fingerprint and each post's own; nothing remembered yet", async () => {
  const { id, res } = await seed();
  expect(res.body.remembered).toEqual({});
  const { payload } = await loadPlan(id);
  expect(payload.chat_fp).toBe(CHAT);
  expect(payload.posts.map((p) => p.pfp)).toEqual([pfp(0), pfp(1), pfp(2)]);
});

test("Save remembers saved and unchanged posts; the next import of the chat hides the saved ones and says so", async () => {
  const { agent, csrf, id } = await seed();
  const kinds = Object.fromEntries((await loadPlan(id)).payload.items.map((i) => [i.row, i.kind]));
  expect(kinds).toMatchObject({ 1: "unchanged", 2: "changed", 3: "new" });
  await form(agent, csrf, `/app/import/${id}/apply`, "rows=2&rows=3");
  expect(await decisions()).toMatchObject({ [pfp(0)]: { outcome: "unchanged" }, [pfp(1)]: { outcome: "saved" }, [pfp(2)]: { outcome: "saved" } });
  expect((await Decisions.list(h.pool, h.AGENCY_A, CHAT)).last_import_at).toEqual(expect.any(String));

  const again = await plan(agent, csrf, POSTS);
  expect(again.body.remembered).toEqual({ 1: "unchanged", 2: "saved", 3: "saved" });
  const page = await agent.get(`/app/import/${again.body.id}`);
  expect(page.text).toMatch(/data-saved-bar[^>]*data-saved="2"/);
  expect(page.text).toContain("2 بوست اتحمل قبل كده");
  expect(page.text).not.toMatch(/data-row="3"/);
  const shown = await agent.get(`/app/import/${again.body.id}?show_saved=1`);
  expect(shown.text).toMatch(/data-row="3"/);
  expect(shown.text).toContain("اخفيهم");
});

test("a post found unchanged before starts unticked even when it now differs; Apply all skips posts the chat already decided", async () => {
  await h.insertListing({ code: "HP-2", details: { owner_phone: "01012345678" } });
  const { agent, csrf } = await signIn(h, "manager");
  await Decisions.record(h.pool, h.AGENCY_A, null, CHAT, [{ post_fp: pfp(1), outcome: "unchanged" }, { post_fp: pfp(2), outcome: "saved" }]);
  const res = await plan(agent, csrf, POSTS);
  const page = await agent.get(`/app/import/${res.body.id}`);
  const card = page.text.match(/<article[^>]*data-row="2"[\s\S]*?<\/article>/)[0];
  expect(card).toMatch(/type="checkbox" name="rows" value="2"(?! checked)/);
  await form(agent, csrf, `/app/import/${res.body.id}/apply`, "all=1");
  const { result } = await loadPlan(res.body.id);
  // Row 2 (remembered unchanged) and row 3 (remembered saved) are left alone; only row 1, a plain unchanged unit, remains.
  expect(result.created).toEqual([]);
  expect(result.updated).toEqual([]);
});

test("Discard is remembered, starts discarded in the next import with a per-post Restore, and Restore forgets it", async () => {
  const { agent, csrf, id } = await seed();
  await form(agent, csrf, `/app/import/${id}/discard`, "row=3");
  expect(await decisions()).toMatchObject({ [pfp(2)]: { outcome: "discarded" } });

  const again = await plan(agent, csrf, POSTS);
  const { payload } = await loadPlan(again.body.id);
  expect(payload.discarded).toEqual([3]);
  const page = await agent.get(`/app/import/${again.body.id}`);
  expect(page.text).toMatch(/data-discarded-bar/);
  expect(page.text).toContain("1 وحدة متجاهلة (1 من تحميل قبل كده)");
  expect(page.text).toMatch(/data-restore="3"/);
  expect(page.text).toMatch(/data-restore-all/);

  await form(agent, csrf, `/app/import/${again.body.id}/discard`, "on=0&row=3");
  expect((await loadPlan(again.body.id)).payload.discarded).toEqual([]);
  expect(await decisions()).not.toHaveProperty(pfp(2));
});

test("Forget remembered decisions for this chat clears them for the agency and the plan starts plain", async () => {
  const { agent, csrf, id } = await seed();
  await form(agent, csrf, `/app/import/${id}/discard`, "row=3");
  await form(agent, csrf, `/app/import/${id}/apply`, "rows=2");
  const again = await plan(agent, csrf, POSTS);
  expect((await agent.get(`/app/import/${again.body.id}`)).text).toMatch(/data-forget-decisions/);
  await form(agent, csrf, `/app/import/${again.body.id}/forget-decisions`, "");
  expect(await decisions()).toEqual({});
  const { payload } = await loadPlan(again.body.id);
  expect(payload.remembered).toEqual({});
  expect(payload.discarded).toEqual([]);
});

test("GET /app/import/decisions tells the browser the last import of a chat; bad ids are refused", async () => {
  const { agent } = await signIn(h, "manager");
  expect((await agent.get(`/app/import/decisions?chat_fp=${CHAT}`)).body).toEqual({ last_import_at: null, count: 0 });
  await Decisions.record(h.pool, h.AGENCY_A, null, CHAT, [{ post_fp: "p1", outcome: "saved" }]);
  const r = await agent.get(`/app/import/decisions?chat_fp=${CHAT}`);
  expect(r.body.count).toBe(1);
  expect(r.body.last_import_at).toEqual(expect.any(String));
  expect((await agent.get("/app/import/decisions?chat_fp=nope")).status).toBe(400);
});

describe("the import date range, as in the app", () => {
  const line = (day, code) => `${day}/11/2026, 10:00 - Ali: شقة للبيع كود ${code} Hyde Park مساحة 150 متر 3 غرف السعر 8 مليون 01012345678`;
  const text = [line("01", "R-1"), line("05", "R-2"), line("12", "R-3"), line("18", "R-4")].join("\n");
  const upload = async (extra) => {
    const { agent, csrf } = await signIn(h, "manager");
    let r = agent.post("/app/import/group").set("X-CSRF-Token", csrf).field("_csrf", csrf);
    for (const [k, v] of Object.entries(extra)) r = r.field(k, v);
    return r.attach("chat", Buffer.from(text), { filename: "WhatsApp Chat with Brokers.txt", contentType: "text/plain" });
  };
  const codes = async (res) => {
    expect(res.status).toBe(303);
    const id = res.headers.location.split("/").pop();
    return (await loadPlan(id)).payload.posts.map((p) => p.text.match(/R-\d/)[0]);
  };

  test("the hub offers the options on both forms", async () => {
    const { agent } = await signIn(h, "manager");
    const page = await agent.get("/app/import");
    for (const v of ["7", "30", "90", "all", "custom"]) expect(page.text).toContain(`<option value="${v}"`);
    expect(page.text).toMatch(/data-cp-range/);
    expect(page.text).toMatch(/name="range"/);
    expect(page.text).toMatch(/data-cp-until/);
    expect(page.text).toMatch(/name="until"/);
    expect(page.text).toContain("من آخر تحميل");
  });

  test("all, custom since/until (until inclusive) and a plain since", async () => {
    expect(await codes(await upload({ range: "all" }))).toEqual(["R-1", "R-2", "R-3", "R-4"]);
    expect(await codes(await upload({ range: "custom", since: "2026-11-04", until: "2026-11-12" }))).toEqual(["R-2", "R-3"]);
    expect(await codes(await upload({ since: "2026-11-10" }))).toEqual(["R-3", "R-4"]);
  });

  test("since last import uses the chat's remembered decisions", async () => {
    const chatFp = FP.chatFingerprint("WhatsApp Chat with Brokers.txt", FP.firstHeaderOf(text));
    await h.pool.query(
      "INSERT INTO chat_import_decisions (agency_id, chat_fp, post_fp, outcome, updated_at) VALUES ($1, $2, 'p1', 'saved', '2026-11-11T09:00:00Z')",
      [h.AGENCY_A, chatFp]
    );
    expect(await codes(await upload({ range: "last" }))).toEqual(["R-3", "R-4"]);
  });
});
