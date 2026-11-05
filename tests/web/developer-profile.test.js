// Developer profile and search (custom plan step 5): free-text profile fields are optional, the developer list
// searches by name in pages of 20, and Ask's project context carries the profile.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const Catalogue = require("../../services/catalogue");
const { build } = require("../../domain/projectContext");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const admin = async () => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];

test("profile fields are optional and the list searches and pages by name", async () => {
  const a = await admin();
  const plain = await Catalogue.saveDeveloper(h.pool, a, { name: "Palm Hills" });
  expect(plain.ok).toBe(true);
  expect(plain.developer.about).toBeNull();

  const rich = await Catalogue.saveDeveloper(h.pool, a, { name: "Emaar", about: "Large developer", warnings: "Late on two projects" });
  expect(rich.developer.warnings).toEqual("Late on two projects");

  for (let i = 0; i < 25; i++) await Catalogue.saveDeveloper(h.pool, a, { name: `Dev ${String(i).padStart(2, "0")}` });

  const found = await Catalogue.listDevelopersPage(h.pool, a, { q: "emaar" });
  expect(found.items.map((d) => d.name)).toEqual(["Emaar"]);

  const first = await Catalogue.listDevelopersPage(h.pool, a, {});
  expect(first.items.length).toBe(20);
  expect(first.pages).toBe(2);
  const second = await Catalogue.listDevelopersPage(h.pool, a, { page: 2 });
  expect(second.items.length).toBe(first.total - 20);
});

test("Ask's project context carries the developer profile and drops empty parts", () => {
  const ctx = build({
    project: { name: "Badya", updated_at: new Date(0) },
    developer: { name: "Emaar", warnings: "Late on two projects", about: null, past_projects: null, delivery_record: null, usual_payment_terms: null }
  });
  expect(ctx.facts.developer_profile).toEqual({ about: null, past_projects: null, delivery_record: null, usual_payment_terms: null, warnings: "Late on two projects" });
  const none = build({ project: { name: "X", updated_at: new Date(0) }, developer: { name: "Y" } });
  expect(none.facts.developer_profile).toBeNull();
});
