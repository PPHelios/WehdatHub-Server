// tests/web/leads-scope.test.js — The agency switch "brokers see all leads" (services/leadScope.js, Haytham 2026-11-15).
// On: a broker reads every lead of the agency but works only their own. Off: own leads only. Never another agency's.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");
const Scope = require("../../services/leadScope");
const Authz = require("../../lib/authz");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("owner");
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const capture = async (who, input) => Leads.captureLead(h.pool, await row(who), { phones: "01012345678", ...input });
const turn = (on) => h.query("UPDATE agencies SET crm_settings = crm_settings || jsonb_build_object('brokers_see_all_leads', $2::boolean) WHERE id = $1", [h.AGENCY_A, on]);
const post = (s, path, body) => s.agent.post(path).type("form").send({ _csrf: s.csrf, ...body });
const names = async (who, url = "/app/leads") => {
  const s = await signIn(h, who);
  return (await s.agent.get(url)).text;
};

beforeEach(async () => {
  await capture("broker", { name: "Sara Mine" });
  await capture("colleague", { phones: "01112345678", name: "Omar Theirs" });
  await capture("rival", { phones: "01212345678", name: "Rival Client" });
});

describe("switch off: own leads only", () => {
  test("a broker sees only their own lead", async () => {
    const t = await names("broker");
    expect(t).toContain("Sara Mine");
    expect(t).not.toContain("Omar Theirs");
  });
});

describe("switch on: all of the agency, read only", () => {
  beforeEach(() => turn(true));

  test("a broker lists every lead of the agency and none of another agency", async () => {
    const t = await names("broker");
    expect(t).toContain("Sara Mine");
    expect(t).toContain("Omar Theirs");
    expect(t).not.toContain("Rival Client");
  });

  test("assigned to me only narrows the list", async () => {
    const t = await names("broker", "/app/leads?mine=1");
    expect(t).toContain("Sara Mine");
    expect(t).not.toContain("Omar Theirs");
  });

  test("a colleague's lead opens, but a broker cannot work it", async () => {
    const other = (await h.query("SELECT ref FROM leads WHERE name = 'Omar Theirs'"))[0].ref;
    const b = await row("broker");
    const lead = await Leads.getLead(h.pool, b, `L-${String(other).padStart(4, "0")}`);
    expect(lead).toBeTruthy();
    expect(Authz.canEditLead(b, lead)).toBe(false);
    const r = await Leads.setStage(h.pool, b, lead.id, { stage: "viewing" });
    expect(r.error).toBe("forbidden");
  });

  test("data entry still sees no leads", async () => {
    await h.query("UPDATE brokers SET role = 'data_entry' WHERE id = $1", [h.BROKERS.colleague.id]);
    expect(await Scope.open(h.pool, await row("colleague"))).toBe(false);
    const s = await signIn(h, "colleague");
    expect((await s.agent.get("/app/leads")).status).toBeGreaterThanOrEqual(300);
  });

  test("a lead of another agency never opens", async () => {
    const id = (await h.query("SELECT id FROM leads WHERE name = 'Rival Client'"))[0].id;
    expect(await Leads.getLead(h.pool, await row("broker"), id)).toBeNull();
  });
});

describe("who changes the switch", () => {
  test("the agency owner changes it and the change is logged; a manager or broker cannot", async () => {
    for (const who of ["admin", "broker"]) {
      const s = await signIn(h, who);
      expect((await post(s, "/app/dashboard/brokers-see-all-leads", { allowed: "on" })).status).toBe(403);
    }
    expect(await Scope.brokersSeeAll(h.pool, h.AGENCY_A)).toBe(false);
    const o = await signIn(h, "owner");
    const r = await post(o, "/app/dashboard/brokers-see-all-leads", { allowed: "on", return: "settings" });
    expect(r.status).toBe(303);
    expect(await Scope.brokersSeeAll(h.pool, h.AGENCY_A)).toBe(true);
    const log = await h.query("SELECT 1 FROM audit_logs WHERE agency_id = $1 AND action = 'brokers_see_all_leads'", [h.AGENCY_A]);
    expect(log.length).toBe(1);
  });

  test("a new agency with no value stored is on", async () => {
    await h.query("UPDATE agencies SET crm_settings = crm_settings - 'brokers_see_all_leads' WHERE id = $1", [h.AGENCY_A]);
    expect(await Scope.brokersSeeAll(h.pool, h.AGENCY_A)).toBe(true);
  });
});
