// tests/web/unit-form-ui.test.js — The add/edit unit form: payment tabs (resale / primary), photo preview ordering hook,
// and the owner's lead code (must be an existing lead the broker can see; kept as L-0042; linked from the unit page).
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

const FIELDS = { listing_type: "sale", market: "resale", property_type: "apartment", compound: "Hyde Park", price_value: "9 مليون", area_value: "150", bedrooms: "3", bathrooms: "2", finishing: "fully_finished", force: "1", owner_name: "Mr Owner", owner_phone: "01012345678" };
const post = (agent, csrf, fields) => {
  let r = agent.post("/app/units/new").field("_csrf", csrf);
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return r;
};

test("the form has payment tabs and the photo preview hook", async () => {
  const { agent } = await signIn(h, "broker");
  const page = await agent.get("/app/units/new?lang=en");
  expect(page.text).toContain('data-tabs="pay"');
  expect(page.text).toContain('id="pay-tab-resale"');
  expect(page.text).toContain('id="pay-tab-primary"');
  expect(page.text).toContain("data-photo-tray");
  expect(page.text).toContain("data-photo-zip");
  expect(page.text).toContain("data-photo-preview");
});

test("a new unit's stepped form names its per-step check address", async () => {
  const { agent } = await signIn(h, "broker");
  const page = await agent.get("/app/units/new?lang=en");
  expect(page.text).toContain('data-check="/app/units/step-check"');
});

test("Next's check returns the blockers as JSON and saves nothing", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  const before = (await h.query("SELECT count(*)::int AS n FROM listings"))[0].n;
  const empty = await agent.post("/app/units/step-check").field("_csrf", csrf).field("listing_type", "sale").field("property_type", "apartment");
  expect(empty.status).toBe(200);
  expect(Array.isArray(empty.body.blockers)).toBe(true);
  expect(empty.body.blockers.map((b) => b.field)).toEqual(expect.arrayContaining(["area_value", "price_value"]));
  let filled = agent.post("/app/units/step-check").field("_csrf", csrf);
  for (const [k, v] of Object.entries(FIELDS)) filled = filled.field(k, v);
  const ok = await filled;
  expect(ok.status).toBe(200);
  expect(ok.body.blockers.map((b) => b.field)).not.toContain("area_value");
  expect((await h.query("SELECT count(*)::int AS n FROM listings"))[0].n).toBe(before);
});

test("owner lead code: unknown codes are refused, a known one is kept as L-0042 and linked from the unit page", async () => {
  const broker = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.broker.id]))[0];
  const lead = await Leads.captureLead(h.pool, broker, { phones: ["01011112222"], name: "Mona Saeed" });
  const { agent, csrf } = await signIn(h, "broker");
  const bad = await post(agent, csrf, { ...FIELDS, owner_lead: "L-9999" });
  expect(bad.status).toBe(422);
  expect(bad.text).toContain("L-9999");
  const ok = await post(agent, csrf, { ...FIELDS, owner_lead: "l 1" });
  expect(ok.status).toBe(303);
  const code = decodeURIComponent(ok.headers.location.match(/units\/([^?]+)/)[1]);
  const row = (await h.query("SELECT details FROM listings WHERE code = $1", [code]))[0];
  expect(row.details.owner_lead).toBe(`L-${String(lead.lead.ref).padStart(4, "0")}`);
  const page = await agent.get(`/app/units/${encodeURIComponent(code)}`);
  expect(page.text).toContain("data-owner-lead");
  // A colleague's client is not linkable.
  const colleague = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.colleague.id]))[0];
  const theirs = await Leads.captureLead(h.pool, colleague, { phones: ["01033334444"], name: "Karim" });
  const other = await post(agent, csrf, { ...FIELDS, owner_lead: `L-${theirs.lead.ref}` });
  expect(other.status).toBe(422);
});

test("the map's review rule does not clip the unit review panel", () => {
  const css = require("fs").readFileSync(require("path").join(__dirname, "../../web/static/app.css"), "utf8");
  expect(css).not.toMatch(/^\[data-review\] \{/m);
  expect(css).toMatch(/\.map-view\[data-review\] \{/);
});

test("Next shows the server's location blocker on the compound field, and photos have delete buttons", () => {
  const fs = require("fs"), path = require("path");
  const js = fs.readFileSync(path.join(__dirname, "../../web/static/app.js"), "utf8");
  expect(js).toContain('blockers[b].field === "location" ? "compound"');
  const view = fs.readFileSync(path.join(__dirname, "../../web/views/unitForm.js"), "utf8");
  expect(view).toContain("data-remove-photo");
  expect(view).not.toMatch(/<label class="check grow"><input type="checkbox" name="remove_photo"/);
});

test("the unit page status row and action buttons are aligned by the stylesheet", () => {
  const css = require("fs").readFileSync(require("path").join(__dirname, "../../web/static/app.css"), "utf8");
  expect(css).toMatch(/\[data-unit-status\] \{ display: contents;/);
  expect(css).toMatch(/#unit-actions \{ display: grid;[^}]*align-items: stretch;/);
  expect(css).toMatch(/#unit-actions > form\.inline \{ display: contents; \}/);
});

test("the edit page keeps its Save row in reach (sticky)", () => {
  const css = require("fs").readFileSync(require("path").join(__dirname, "../../web/static/app.css"), "utf8");
  expect(css).toMatch(/#unit-form:not\(\[data-steps\]\) \[data-save-row\] \{ position: sticky;/);
});

// Photos upload at Save, so the page checks the form first (check_only) and tells the review how many photos wait (photo_pending).
const { force: _f, ...NOFORCE } = FIELDS;
const review = (agent, csrf, extra) => {
  let r = agent.post("/app/units/review").field("_csrf", csrf);
  for (const [k, v] of Object.entries({ ...NOFORCE, ...extra })) r = r.field(k, v);
  return r;
};

test("the review counts photos still waiting for Save, so it never says 'no photos' for them", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  const none = await review(agent, csrf, { photo_pending: "0" });
  const waiting = await review(agent, csrf, { photo_pending: "2" });
  expect(none.text).toMatch(/الصور غير مسجل|Photos not recorded|Photos/);
  expect(waiting.text).not.toMatch(/الصور غير مسجل/);
  expect(waiting.text.length).toBeLessThan(none.text.length);
});

test("check_only answers ok before any photo work and saves nothing; a refusal comes back as the form", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  const before = (await h.query("SELECT count(*)::int AS n FROM listings"))[0].n;
  const ok = await post(agent, csrf, { ...NOFORCE, check_only: "1" });
  expect(ok.status).toBe(200);
  expect(ok.body).toEqual({ ok: true });
  const missing = await post(agent, csrf, { ...NOFORCE, check_only: "1", area_value: "" });
  expect(missing.status).toBe(422);
  expect(missing.text).toContain('id="unit-form"');
  expect((await h.query("SELECT count(*)::int AS n FROM listings"))[0].n).toBe(before);
});

test("a look-alike unit is refused once; accepted at Next (dup_ack) or with Save anyway it is not asked again", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  await h.insertListing({ code: "HP300", compound: "Hyde Park", property_type: "apartment", listing_type: "sale", bedrooms: 3, area_value: 150, price_value: 9e6 });
  const asked = await post(agent, csrf, { ...NOFORCE, code: "HP302" });
  expect(asked.status).toBe(409);
  expect(asked.text).toContain("HP300");
  const checkAsked = await post(agent, csrf, { ...NOFORCE, code: "HP302", check_only: "1" });
  expect(checkAsked.status).toBe(409);
  const acked = await post(agent, csrf, { ...NOFORCE, code: "HP302", dup_ack: "1" });
  expect(acked.status).toBe(303);
});

test("edit: check_only answers ok without saving; a stale version is refused before any photo is uploaded", async () => {
  const row = await h.insertListing({ code: "NH-E1", compound: "Hyde Park", property_type: "apartment", listing_type: "sale", bedrooms: 3, area_value: 150, price_value: 9e6 });
  const { agent, csrf } = await signIn(h, "broker");
  const edit = (extra) => {
    let r = agent.post("/app/units/NH-E1/edit").field("_csrf", csrf).field("check_only", "1");
    for (const [k, v] of Object.entries({ ...NOFORCE, code: "NH-E1", ...extra })) r = r.field(k, v);
    return r;
  };
  const ok = await edit({ version: String(row.version), price_value: "9.5 مليون" });
  expect(ok.status).toBe(200);
  expect(ok.body).toEqual({ ok: true });
  expect(Number((await h.query("SELECT price_value FROM listings WHERE code = 'NH-E1'"))[0].price_value)).toBe(9e6);
  const stale = await edit({ version: String(row.version + 5), price_value: "9.5 مليون" });
  expect(stale.status).toBe(409);
  expect(stale.text).toContain('id="unit-form"');
});
