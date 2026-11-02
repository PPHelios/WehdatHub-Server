// tests/web/viewing-picker.test.js — the viewing form: the unit code is optional, the client's message language is chosen
// on the form, and the time picker page takes the broker back to the form with the chosen time.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");
const Stages = require("../../domain/leadStages");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

async function lead() {
  const r = await Leads.captureLead(h.pool, h.BROKERS.broker, { name: "Mona Adel", phone: "01001234567", lawfulBasis: "client_request" }, { quiet: true });
  return r.lead;
}

test("the viewing form has an optional unit code and a message language picker", async () => {
  await lead();
  const s = await signIn(h, "broker");
  const page = (await s.agent.get("/app/leads/L-0001")).text;
  expect(page).toContain("كود الوحدة (اختياري)");
  expect(page).toContain('name="msg_lang"');
  expect(page).toContain("/app/leads/L-0001/viewing/pick");
});

test("a viewing without a unit code is scheduled; the message has no unit line and uses the chosen language", async () => {
  await lead();
  const s = await signIn(h, "broker");
  const at = Stages.cairoDayAt(new Date(), 2, 15);
  const r = await s.agent.post("/app/leads/L-0001/viewing").set("X-CSRF-Token", s.csrf).type("form").send({ at: Stages.toCairoLocal(at), unit: "", place: "Gate 3", msg_lang: "en" });
  expect(r.status).toBe(303);
  const [v] = await h.query("SELECT listing_id, place, status FROM viewings");
  expect(v).toMatchObject({ listing_id: null, place: "Gate 3", status: "proposed" });
  expect(r.headers.location).toMatch(/wa\.me|api\.whatsapp/);
  const message = decodeURIComponent(r.headers.location);
  expect(message).toContain("Your viewing:");
  expect(message).not.toContain("🏠");
});

test("the time picker lists hours for the next week and links back to the form with that time", async () => {
  await lead();
  const s = await signIn(h, "broker");
  const page = (await s.agent.get("/app/leads/L-0001/viewing/pick")).text;
  expect(page).toMatch(/data-day="\d{4}-\d{2}-\d{2}"/);
  expect(page.match(/data-day=/g).length).toBe(7);
  expect(page).toMatch(/href="\/app\/leads\/L-0001\?at=\d{4}-\d{2}-\d{2}T\d{2}:00#viewing"/);
  const picked = await s.agent.get("/app/leads/L-0001?at=2030-05-03T17:00");
  expect(picked.text).toContain('value="2030-05-03T17:00"');
});
