// Plan rules and exceptions (custom plan calculator, step 2): a plan outside the project's rules is marked for review;
// an approved plan stays approved; a plan inside the rules carries no exception.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const Catalogue = require("../../services/catalogue");
const PlanRules = require("../../services/planRules");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

test("plans are checked against the project's rules", async () => {
  const admin = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];
  const p = (await Catalogue.saveProject(h.pool, admin, { name: "Rules Test" })).project;

  const saved = await PlanRules.saveRules(h.pool, admin, p.id, { min_down_payment_pct: "10", max_years: "8", frequencies: ["quarterly"] });
  expect(saved.ok).toBe(true);

  const outside = (await Catalogue.savePlan(h.pool, admin, p.id, { name: "5% / 9y", down_payment_pct: "5", years: "9", frequency: "quarterly" })).plan;
  expect(outside.exception_status).toBe("needs_approval");

  const inside = (await Catalogue.savePlan(h.pool, admin, p.id, { name: "10% / 8y", down_payment_pct: "10", years: "8", frequency: "quarterly" })).plan;
  expect(inside.exception_status).toBe("none");

  const approved = await h.query("UPDATE project_plans SET exception_status = 'approved' WHERE id = $1 RETURNING *", [outside.id]);
  const again = (await Catalogue.savePlan(h.pool, admin, p.id, { id: outside.id, name: "5% / 9y", down_payment_pct: "5", years: "9", frequency: "quarterly" })).plan;
  expect(approved[0].exception_status).toBe("approved");
  expect(again.exception_status).toBe("approved");
});
