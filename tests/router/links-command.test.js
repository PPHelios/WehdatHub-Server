// tests/router/links-command.test.js — The bot's "links" command: a short summary of the broker's client links (sent, opened,
// never opened, opened more than once) with the link to the full page. The summary follows the same visibility as the page.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness, textOf } = require("../harness/app");
const Share = require("../../lib/shareLinks");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const brokerRow = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];

test("links with nothing sent yet says so, in one line", async () => {
  const out = await h.text("broker", "روابط");
  expect(textOf(out)).toMatch(/مفيش روابط للعملاء لسه/);
});

test("links shows counts for the broker's own links and the page link", async () => {
  const l1 = await h.insertListing({ broker_id: h.BROKERS.broker.id, code: "LK-1" });
  const l2 = await h.insertListing({ broker_id: h.BROKERS.broker.id, code: "LK-2" });
  const l3 = await h.insertListing({ broker_id: h.BROKERS.broker.id, code: "LK-3" });
  const broker = await brokerRow("broker");
  await Share.createShareLink(h.pool, broker, l1, { channel: "whatsapp", lang: "ar", source: "bot" });
  await Share.createShareLink(h.pool, broker, l2, { channel: "whatsapp", lang: "ar", source: "bot" });
  await Share.createShareLink(h.pool, broker, l3, { channel: "whatsapp", lang: "ar", source: "bot" });
  await h.query("UPDATE share_links SET open_count = 3, last_opened_at = now() WHERE listing_id = $1", [l2.id]);
  await h.query("UPDATE share_links SET created_at = now() - interval '10 days' WHERE listing_id = $1", [l3.id]);
  const text = textOf(await h.text("broker", "روابط"));
  expect(text).toMatch(/اتبعتت في آخر ٧ أيام: 2/);
  expect(text).toMatch(/اتفتحت في آخر ٤٨ ساعة: 1/);
  expect(text).toMatch(/اتفتحت أكتر من مرة: 1/);
  expect(text).toMatch(/\/app\/links/);
});

test("data entry gets no link summary", async () => {
  await h.pool.query("UPDATE brokers SET role = 'data_entry' WHERE id = $1", [h.BROKERS.colleague.id]);
  const text = textOf(await h.text("colleague", "links"));
  expect(text).not.toMatch(/Client links|روابط العملاء/);
});
