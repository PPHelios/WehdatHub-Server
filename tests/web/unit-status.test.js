// tests/web/unit-status.test.js — Unit status on the web: Active by default, changed from the unit page, counts on the tabs.
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
  await h.seedBroker("manager");
});
afterAll(closeHarness);

const statusOf = async (code) => (await h.query("SELECT status FROM listings WHERE code_norm = upper($1)", [code]))[0].status;

describe("unit status on the web", () => {
  test("a manager changes a unit to sold from the unit page", async () => {
    await h.insertListing({ code: "VIL-41", compound: "Hyde Park" });
    const { agent, csrf } = await signIn(h, "manager");
    const page = await agent.get("/app/units/VIL-41");
    expect(page.text).toContain("data-unit-status");
    const r = await agent.post("/app/units/VIL-41/status").type("form").send({ _csrf: csrf, status: "sold" });
    expect(r.status).toBe(303);
    expect(await statusOf("VIL-41")).toBe("sold");
  });

  test("an unknown status is refused and the unit stays as it was", async () => {
    await h.insertListing({ code: "VIL-42", compound: "Hyde Park" });
    const { agent, csrf } = await signIn(h, "manager");
    const r = await agent.post("/app/units/VIL-42/status").type("form").send({ _csrf: csrf, status: "deleted" });
    expect(r.status).toBe(400);
    expect(await statusOf("VIL-42")).toBe("active");
  });

  test("the Sold tab shows how many sold units there are", async () => {
    await h.insertListing({ code: "VIL-43", compound: "Hyde Park", status: "sold" });
    const { agent } = await signIn(h, "manager");
    const r = await agent.get("/app/units?status=sold");
    expect(r.text).toContain("(1)");
  });

  test("the unit page has Change status, client link and flyer buttons; the flyer page makes the image, with or without brand", async () => {
    await h.insertListing({ code: "VIL-44", compound: "Hyde Park" });
    const { agent } = await signIn(h, "manager");
    const page = await agent.get("/app/units/VIL-44");
    expect(page.text).toContain("status-menu");
    expect(page.text).toContain('href="#share"');
    expect(page.text).toContain("/app/units/VIL-44/flyer");
    const branded = await agent.get("/app/units/VIL-44/flyer");
    expect(branded.status).toBe(200);
    const src = (r) => (r.text.match(/data-flyer-image/) ? r.text.match(/<img src="([^"]+)"[^>]*data-flyer-image/)?.[1] : null);
    expect(src(branded)).toBeTruthy();
    const plain = await agent.get("/app/units/VIL-44/flyer?unbranded=1");
    expect(src(plain)).toBeTruthy();
    expect(src(plain)).not.toBe(src(branded));
  });
});
