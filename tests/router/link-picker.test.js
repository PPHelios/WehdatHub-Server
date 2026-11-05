// tests/router/link-picker.test.js — Telegram: after a client copy, "who is this for?" offers a number, a lead ID, a shared
// contact, or skip. The answer attaches to the link the copy just made. Skip leaves it with no recipient.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness, textOf } = require("../harness/app");
const Leads = require("../../services/leads");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const brokerRow = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const linkRows = () => h.query("SELECT recipient_phone, lead_id, source FROM share_links ORDER BY created_at");
const pickerButtons = (out) => out.flatMap((e) => (e.keyboard || []).flat()).filter((b) => /^lk:/.test(b.callback_data || ""));

/** Makes a client copy for the unit (the bot's button) and returns the picker's buttons. */
async function copyFor(code) {
  await h.insertListing({ broker_id: h.BROKERS.broker.id, code });
  await h.tgLink("broker");
  const out = await h.tgTap("broker", `client:${code}`);
  return pickerButtons(out);
}

test("a client copy offers who it is for; a typed number attaches it to that link", async () => {
  const buttons = await copyFor("TP-1");
  expect(buttons.map((b) => b.callback_data).sort()).toEqual(["lk:contact", "lk:id", "lk:num", "lk:skip"]);
  await h.tgTap("broker", "lk:num");
  const asked = await h.tgText("broker", "01012345678");
  expect(textOf(asked)).toMatch(/اسم العميل|client's name/);
  expect(await linkRows()).toEqual([{ recipient_phone: null, lead_id: null, source: "bot" }]);
  const out = await h.tgText("broker", "Nour");
  expect(textOf(out)).toMatch(/اتربط|Linked/);
  expect(JSON.stringify(out)).toMatch(/wa\.me\/201012345678/);
  const [row] = await linkRows();
  expect(row).toMatchObject({ recipient_phone: "201012345678", source: "bot" });
  expect(row.lead_id).not.toBeNull();
  expect(await h.query("SELECT name, phone_e164, assigned_broker_id FROM leads")).toEqual([{ name: "Nour", phone_e164: "+201012345678", assigned_broker_id: h.BROKERS.broker.id }]);
});

test("a lead ID attaches the lead and its number", async () => {
  const lead = (await Leads.captureLead(h.pool, await brokerRow("broker"), { phones: "01055512345", name: "Ahmed" })).lead;
  await copyFor("TP-2");
  await h.tgTap("broker", "lk:id");
  await h.tgText("broker", `L-${String(lead.ref).padStart(4, "0")}`);
  expect(await linkRows()).toEqual([{ recipient_phone: "201055512345", lead_id: lead.id, source: "bot" }]);
});

test("a shared contact attaches its number", async () => {
  await copyFor("TP-3");
  await h.tgTap("broker", "lk:contact");
  await h.tg("broker", { contact: { phone_number: "+201066600011", first_name: "Sara", user_id: 555 } });
  const [row] = await linkRows();
  expect(row).toMatchObject({ recipient_phone: "201066600011", source: "bot" });
  expect(row.lead_id).not.toBeNull();
  expect(await h.query("SELECT name FROM leads")).toEqual([{ name: "Sara" }]);
});

test("skip leaves the link with no recipient, and the choice is cleared", async () => {
  await copyFor("TP-4");
  await h.tgTap("broker", "lk:skip");
  expect(await linkRows()).toEqual([{ recipient_phone: null, lead_id: null, source: "bot" }]);
  // A later text is an ordinary message again (not an answer to the picker).
  const after = await h.tgText("broker", "01012345678");
  expect(await linkRows()).toEqual([{ recipient_phone: null, lead_id: null, source: "bot" }]);
  expect(after).toBeDefined();
});

test("an invalid number is refused and the choice stays open for another try", async () => {
  await copyFor("TP-5");
  await h.tgTap("broker", "lk:num");
  const bad = await h.tgText("broker", "12345");
  expect(textOf(bad)).toMatch(/مش صحيح|isn't a valid/);
  expect(await linkRows()).toEqual([{ recipient_phone: null, lead_id: null, source: "bot" }]);
  await h.tgText("broker", "01012345678");
  await h.tgText("broker", "skip");
  expect(await linkRows()).toEqual([{ recipient_phone: "201012345678", lead_id: expect.anything(), source: "bot" }]);
  expect(await h.query("SELECT name FROM leads")).toEqual([{ name: "+201012345678" }]);
});
