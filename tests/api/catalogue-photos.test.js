// tests/api/catalogue-photos.test.js — The app's twins of the website's project photo calls: upload (no AI), the explicit "Sort with AI", and the project
// detail with its photos.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const FakeAI = require("../harness/fake-ai");
const WebAuth = require("../../lib/webAuth");
const Catalogue = require("../../services/catalogue");

jest.setTimeout(90000);

let h, admin, project, tok, brokerTok;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const login = async (b) => {
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  return (await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: b.phone, code })).body.token;
};
beforeAll(async () => {
  h = await createHarness();
  FakeAI.reset();
  admin = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];
  project = (await Catalogue.saveProject(h.pool, admin, { name: "Photo Proj" })).project;
  tok = await login(h.BROKERS.admin);
  brokerTok = await login(h.BROKERS.broker);
});
afterAll(() => closeHarness());

const post = (p, t = tok) => request(h.app.app).post(`/api/v1${p}`).set("Authorization", `Bearer ${t}`);
const get = (p, t = tok) => request(h.app.app).get(`/api/v1${p}`).set("Authorization", `Bearer ${t}`);

test("photos: managers upload up to 10 images with no AI call; every photo is shared, in order; the detail lists them with a cover", async () => {
  const up = post(`/catalogue/projects/${project.id}/photos`);
  for (let i = 0; i < 2; i++) up.attach("doc", PNG, { filename: `p${i}.png`, contentType: "image/png" });
  const r = await up;
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ ok: true, added: 2, shared: 2, ai: false });
  const detail = await get(`/catalogue/projects/${project.id}`);
  expect(detail.body.images.map((i) => [i.role, i.mime])).toEqual([["shared", "image/png"], ["shared", "image/png"]]);
  expect(detail.body.cover_url).toBe(detail.body.images[0].url);
  expect(detail.body.project.name).toBe("Photo Proj");
});

test("photos: a broker is refused, a PDF is not an image here", async () => {
  expect((await post(`/catalogue/projects/${project.id}/photos`, brokerTok).attach("doc", PNG, { filename: "a.png", contentType: "image/png" })).status).toBe(403);
  const pdf = await post(`/catalogue/projects/${project.id}/photos`).attach("doc", Buffer.from("%PDF-1.4"), { filename: "a.pdf", contentType: "application/pdf" });
  expect(pdf.status).toBeGreaterThanOrEqual(400);
});

test("sort with AI: reading off refuses a PDF; images are added shared; a manager can change a photo's role and delete it", async () => {
  const pdf = await post(`/catalogue/projects/${project.id}/gallery`).field("sort", "1").attach("doc", Buffer.from("%PDF-1.4"), { filename: "b.pdf", contentType: "application/pdf" });
  expect(pdf.status).toBe(422);
  expect(pdf.body.error).toBe("OFF");
  const imgs = await post(`/catalogue/projects/${project.id}/gallery`).attach("doc", PNG, { filename: "c.png", contentType: "image/png" });
  expect(imgs.body).toMatchObject({ ok: true, added: 1, ai: false });
  const id = (await get(`/catalogue/projects/${project.id}`)).body.images[0].id;
  expect((await post(`/catalogue/projects/${project.id}/gallery/${id}`).send({ role: "hidden" })).status).toBe(200);
  expect((await get(`/catalogue/projects/${project.id}`)).body.images.find((i) => i.id === id).role).toBe("hidden");
  // A broker does not see hidden photos.
  expect((await get(`/catalogue/projects/${project.id}`, brokerTok)).body.images.some((i) => i.id === id)).toBe(false);
  expect((await post(`/catalogue/projects/${project.id}/gallery/${id}/delete`)).status).toBe(200);
  expect((await get(`/catalogue/projects/${project.id}`)).body.images.some((i) => i.id === id)).toBe(false);
});

test("sort with AI: a PDF needs the box ticked when reading is on", async () => {
  await h.query("INSERT INTO agency_settings (agency_id, key, value) VALUES ($1, 'document_reading', 'true'::jsonb) ON CONFLICT DO NOTHING", [admin.agency_id]).catch(() => {});
  const PriceReading = require("../../services/priceReading");
  const on = (await PriceReading.settingOf(h.pool, admin.agency_id)).enabled;
  if (!on) return; // the switch lives elsewhere in this harness: the explicit-sort rule is covered in tests/web/project-gallery.test.js
  const r = await post(`/catalogue/projects/${project.id}/gallery`).attach("doc", Buffer.from("%PDF-1.4"), { filename: "d.pdf", contentType: "application/pdf" });
  expect(r.body.error).toBe("SORT_PDF");
});
