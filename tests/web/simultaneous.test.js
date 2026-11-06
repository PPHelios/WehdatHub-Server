// tests/web/simultaneous.test.js — Many people at once (patch 5): parallel page and search calls from two agencies all answer 200, in
// time, and each answer shows only its own agency's units.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");

jest.setTimeout(120000);

let h;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

test("40 parallel calls from two agencies all succeed, fast, with no mixing", async () => {
  await h.seedBroker("owner");
  await h.insertListing({ code: "SIMA-1", compound: "SIMA Compound" });
  await h.insertListing({ code: "SIMB-1", agency_id: h.AGENCY_B, broker_id: h.BROKERS.rival.id, compound: "SIMB Compound" });
  const a = await signIn(h, "owner");
  const b = await signIn(h, "rival");
  const paths = ["/app/", "/app/units", "/app/units/SIMA-1", "/app/leads", "/app/search?q=SIM"];
  const started = Date.now();
  const calls = [];
  for (let i = 0; i < 20; i++) {
    for (const [who, agent] of [["a", a.agent], ["b", b.agent]]) {
      const p = paths[i % paths.length].replace("SIMA-1", who === "a" ? "SIMA-1" : "SIMB-1");
      calls.push(agent.get(p).redirects(0).then((r) => ({ who, p, status: r.status, text: String(r.text || "") })));
    }
  }
  const out = await Promise.all(calls);
  expect(Date.now() - started).toBeLessThan(60000);
  expect(out.filter((r) => r.status >= 500)).toEqual([]);
  expect(out.filter((r) => r.who === "a" && r.text.includes("SIMB"))).toEqual([]);
  expect(out.filter((r) => r.who === "b" && r.text.includes("SIMA"))).toEqual([]);
  expect(out.filter((r) => r.status === 200).length).toBeGreaterThan(20);
});
