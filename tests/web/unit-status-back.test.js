// tests/web/unit-status-back.test.js — The status and access forms send the user back only to an app page (never to another site).
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

// A plain urlencoded form with the CSRF header (multipart is refused on this route).
const status = (agent, csrf, code, value, back) =>
  agent.post(`/app/units/${code}/status`).set("X-CSRF-Token", csrf).type("form").send(back === undefined ? { status: value } : { status: value, back });

describe("status form: where it sends the user back", () => {
  test("a safe app page is kept", async () => {
    await h.insertListing({ code: "HP-B1" });
    const { agent, csrf } = await signIn(h, "broker");
    const r = await status(agent, csrf, "HP-B1", "sold", "/app/units?status=active&old=1");
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe("/app/units?status=active&old=1");
    const [row] = await h.query("SELECT status FROM listings WHERE code_norm = 'HP-B1'");
    expect(row.status).toBe("sold");
  });

  test("the daily card's home page is kept", async () => {
    await h.insertListing({ code: "HP-B2" });
    const { agent, csrf } = await signIn(h, "broker");
    expect((await status(agent, csrf, "HP-B2", "archived", "/app")).headers.location).toBe("/app");
  });

  test.each(["//evil.example", "/app//evil.example", "https://evil.example/app", "/appx"])("%s is refused, the unit page is used", async (back) => {
    await h.insertListing({ code: "HP-B3" });
    const { agent, csrf } = await signIn(h, "broker");
    const r = await status(agent, csrf, "HP-B3", "sold", back);
    expect(r.headers.location).toBe("/app/units/HP-B3?saved=1");
  });
});

describe("access form: where it sends the user back", () => {
  test("another site is refused", async () => {
    await h.insertListing({ code: "HP-B4" });
    const { agent, csrf } = await signIn(h, "broker");
    const r = await agent.post("/app/units/HP-B4/access").set("X-CSRF-Token", csrf).type("form").send({ back: "//evil.example" });
    expect(r.headers.location).toBe("/app/units/HP-B4?private=asked#private");
  });
});
