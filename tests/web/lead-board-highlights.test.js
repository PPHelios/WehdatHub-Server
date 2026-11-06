// tests/web/lead-board-highlights.test.js — The lead board: VIP and Portal are cards above the stage bar with a count (not
// stage chips); the board has arrow buttons to move between columns.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const broker = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];

test("VIP and Portal are cards with counts; the stage bar has only stages; the board has arrow buttons", async () => {
  await h.seedBroker("owner");
  await Leads.captureLead(h.pool, await broker("broker"), { phones: "01012345678", name: "Sara Card" });
  await h.query("UPDATE leads SET is_private = true WHERE name = 'Sara Card'");
  const { agent } = await signIn(h, "owner");
  const list = (await agent.get("/app/leads?lang=en")).text;
  expect(list).toMatch(/class="scard vip[^"]*"[^>]*>[\s\S]*?<b>1<\/b>/);
  expect(list).toMatch(/class="scard portal[^"]*"/);
  const bar = list.match(/<ul class="chipbar"[\s\S]*?<\/ul>/)[0];
  expect(bar).not.toMatch(/tab=private/);
  expect(bar).not.toMatch(/tab=portal/);
  const board = (await agent.get("/app/leads/board?lang=en")).text;
  expect(board).toMatch(/data-board-step="-1"/);
  expect(board).toMatch(/data-board-step="1"/);
  expect(board).toMatch(/class="board-cols" data-board/);
});
