// tests/web/negative-paths.test.js — Plan item 16: wrong, hostile and edge inputs on the screens built in this plan. Each
// case must be refused or ignored with nothing changed, never a 500 and never another agency's data.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const { resetConfig } = require("../../config");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("owner");
});
afterAll(async () => {
  delete process.env.OWNER_BROKER_IDS;
  resetConfig();
  await closeHarness();
});

const post = (s, path, body) => s.agent.post(path).type("form").send({ _csrf: s.csrf, ...body });
const agency = async () => (await h.query("SELECT ai_usage_mode AS mode, ai_user_default_credits AS d FROM agencies WHERE id = $1", [h.AGENCY_A]))[0];

describe("AI limits: bad input changes nothing", () => {
  test.each([
    ["an unknown mode", { ai_mode: "unlimited", ai_default: "10" }],
    ["a negative default", { ai_mode: "per_user", ai_default: "-1" }],
    ["text as a default", { ai_mode: "per_user", ai_default: "abc" }],
    ["a script as a default", { ai_mode: "per_user", ai_default: "<script>alert(1)</script>" }]
  ])("%s is refused and the settings stay", async (_label, body) => {
    const before = await agency();
    const s = await signIn(h, "owner");
    const r = await post(s, "/app/usage/ai-limits", body);
    expect(r.status).toBeLessThan(500);
    expect(await agency()).toEqual(before);
  });

  test("a limit for a person in another agency is ignored", async () => {
    const s = await signIn(h, "owner");
    await post(s, "/app/usage/ai-limits", { ai_mode: "per_user", ai_default: "20", [`ov_${h.BROKERS.rival.id}`]: "999" });
    const [rival] = await h.query("SELECT ai_user_credits AS c FROM brokers WHERE id = $1", [h.BROKERS.rival.id]);
    expect(rival.c).toBeNull();
  });

  test("an override that is not a number is ignored, not stored as text", async () => {
    const s = await signIn(h, "owner");
    const r = await post(s, "/app/usage/ai-limits", { ai_mode: "per_user", ai_default: "20", [`ov_${h.BROKERS.broker.id}`]: "lots" });
    expect(r.status).toBeLessThan(500);
    const [b] = await h.query("SELECT ai_user_credits AS c FROM brokers WHERE id = $1", [h.BROKERS.broker.id]);
    expect(b.c === null || Number.isInteger(b.c)).toBe(true);
  });

  test("a rival agency's owner cannot change this agency's limits", async () => {
    const s = await signIn(h, "rival");
    const r = await post(s, "/app/usage/ai-limits", { ai_mode: "per_user", ai_default: "5" });
    expect([303, 403]).toContain(r.status);
    expect((await agency()).mode).toBe("pool");
  });
});

describe("the owner board and the activity log", () => {
  test("a broker and a manager cannot open the new board views", async () => {
    for (const who of ["broker", "admin"]) {
      const s = await signIn(h, who);
      for (const q of ["view=health", "view=content", "tab=health", "tab=content", "view=nope", "tab=%27%3B--"]) {
        const r = await s.agent.get(`/app/owner/board?${q}`);
        expect([who, q, r.status]).toEqual([who, q, 404]);
      }
    }
  });

  test("the owner gets a normal page for an unknown view or tab, not an error", async () => {
    process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
    resetConfig();
    const s = await signIn(h, "admin");
    for (const q of ["view=nope", "tab=%27%3B--", "days=9999", "view=health&days=abc"]) {
      const r = await s.agent.get(`/app/owner/board?${q}`);
      expect([q, r.status]).toEqual([q, 200]);
    }
  });

  test("a broker cannot open the activity log; a manager sees no technical details", async () => {
    const b = await signIn(h, "broker");
    expect((await b.agent.get("/app/activity-log")).status).toBeGreaterThanOrEqual(400);
    const m = await signIn(h, "admin");
    const page = await m.agent.get("/app/activity-log");
    expect(page.status).toBe(200);
    expect(page.text).not.toContain("<details class=\"small\">"); // details are for the app owner only
  });
});

describe("settings and imports", () => {
  test("a broker cannot post the agency's settings forms", async () => {
    const s = await signIn(h, "broker");
    for (const path of ["/app/usage/fx", "/app/usage/agency", "/app/dashboard/secret-details", "/app/dashboard/brokers-edit-units"]) {
      const r = await post(s, path, { return: "settings", scope: "managers", allowed: "on" });
      expect([path, r.status]).toEqual([path, 403]);
    }
  });

  test("a write without the CSRF token is refused", async () => {
    const s = await signIn(h, "owner");
    const r = await s.agent.post("/app/usage/ai-limits").type("form").send({ ai_mode: "per_user", ai_default: "5" });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await agency()).mode).toBe("pool");
  });

  test("the settings page opens in both languages for every role without an error", async () => {
    for (const who of ["owner", "admin", "broker", "rival"]) {
      const s = await signIn(h, who);
      for (const lang of ["ar", "en"]) {
        const r = await s.agent.get(`/app/settings?lang=${lang}`);
        expect([who, lang, r.status < 500]).toEqual([who, lang, true]);
      }
    }
  });
});
