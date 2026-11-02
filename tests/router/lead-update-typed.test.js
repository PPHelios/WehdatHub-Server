// tests/router/lead-update-typed.test.js — the typed update on Telegram: after a lead card, "Add update" asks for one text
// message, which is saved as a note on the lead's timeline. Voice never does this.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const Leads = require("../../services/leads");

jest.setTimeout(60000);

let h;
const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const buttonsOf = (out) => out.flatMap((e) => (e.keyboard || []).flat()).map((b) => b.callback_data);
const noteEvents = async () => h.query("SELECT data FROM lead_events WHERE kind = 'note' ORDER BY created_at");

beforeEach(async () => {
  h = await createHarness();
  await h.tgLink("broker");
  await Leads.captureLead(h.pool, await row("broker"), { phones: "01012345678", name: "Sara Typed" });
});
afterAll(closeHarness);

test("the lead card offers Add update, and the typed text is saved as a timeline note", async () => {
  const card = await h.tgText("broker", "L-0001");
  expect(buttonsOf(card)).toContain("ld:note:L-0001");

  await h.tgTap("broker", "ld:note:L-0001");
  await h.tgText("broker", "Client wants a second viewing on Friday");
  const notes = await noteEvents();
  expect(notes.map((n) => n.data.text)).toEqual(["Client wants a second viewing on Friday"]);
});

test("cancelling the update writes nothing", async () => {
  await h.tgText("broker", "L-0001");
  await h.tgTap("broker", "ld:note:L-0001");
  await h.tgText("broker", "إلغاء");
  expect(await noteEvents()).toEqual([]);
});
