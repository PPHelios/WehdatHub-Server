// tests/web/storage-check.test.js — The weekly storage check reports unused photo files (dry run) and deletes them only when switched on.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => ({ ...require("../harness/fake-supabase"), deleteStorageFiles: jest.fn(async () => true) }));

const { createHarness, closeHarness } = require("../harness/app");
const Supabase = require("../../lib/supabase");
const StorageCheck = require("../../services/storageCheck");
const Alerts = require("../../services/systemAlerts");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  Supabase.deleteStorageFiles.mockClear();
  await h.query("CREATE SCHEMA IF NOT EXISTS storage");
  await h.query("DROP TABLE IF EXISTS storage.objects");
  await h.query("CREATE TABLE storage.objects (bucket_id text, name text, created_at timestamptz DEFAULT now(), metadata jsonb)");
  const old = "NOW() - INTERVAL '10 days'";
  await h.query(`INSERT INTO storage.objects (bucket_id, name, created_at, metadata) VALUES
    ('listing-images', 'a/used.jpg', ${old}, '{"size": 1000}'), ('listing-images', 'a/orphan.jpg', ${old}, '{"size": 2000}'),
    ('listing-images', 'a/fresh.jpg', NOW(), '{"size": 500}')`);
  await h.query("UPDATE agencies SET logo_url = 'https://x/storage/v1/object/public/listing-images/a/used.jpg' WHERE id = $1", [h.BROKERS.admin.agency_id]);
});
afterEach(() => h.query("DROP TABLE IF EXISTS storage.objects"));
afterAll(closeHarness);

test("a dry run reports old unused files and deletes nothing", async () => {
  const out = await StorageCheck.run(h.pool, { deleteFiles: false });
  expect(out).toMatchObject({ orphans: 1, orphan_bytes: 2000, deleted: 0, dry_run: true });
  expect(Supabase.deleteStorageFiles).not.toHaveBeenCalled();
});

test("with deleting switched on only the old unused file is removed", async () => {
  const out = await StorageCheck.run(h.pool, { deleteFiles: true });
  expect(out.deleted).toBe(1);
  expect(Supabase.deleteStorageFiles).toHaveBeenCalledWith(["a/orphan.jpg"]);
});

test("the CRM owner is alerted after a dry run that found files", async () => {
  await h.query("INSERT INTO crm_jobs (name, watermark) VALUES ('storage_check', '{\"orphans\": 3, \"bytes\": 3145728, \"dry_run\": true}') ON CONFLICT (name) DO UPDATE SET watermark = EXCLUDED.watermark");
  expect((await Alerts.due(h.pool)).map((a) => a.key)).toContain("storage_orphans");
});

test("the delete switch accepts stray spaces, case and quotes", () => {
  for (const v of ["true", " true ", "TRUE", "'true'", "1", "yes"]) expect(StorageCheck.deleteSwitchOn(v)).toBe(true);
  for (const v of ["", undefined, "false", "0", "no", "tru"]) expect(StorageCheck.deleteSwitchOn(v)).toBe(false);
});

test("after a run that deleted files the owner sees that deletion ran, not a dry-run prompt", async () => {
  await h.query("INSERT INTO crm_jobs (name, watermark) VALUES ('storage_check', '{\"orphans\": 1, \"bytes\": 2000, \"dry_run\": false, \"deleted\": 1}') ON CONFLICT (name) DO UPDATE SET watermark = EXCLUDED.watermark");
  const keys = (await Alerts.due(h.pool)).map((a) => a.key);
  expect(keys).toContain("storage_deleted");
  expect(keys).not.toContain("storage_orphans");
});

test("a small copy is in use while its original is, and unused when its original is not", async () => {
  await h.query(`INSERT INTO storage.objects (bucket_id, name, created_at, metadata) VALUES
    ('listing-images', 'thumbs/a/used.jpg', NOW() - INTERVAL '10 days', '{"size": 100}'),
    ('listing-images', 'thumbs/a/orphan.jpg', NOW() - INTERVAL '10 days', '{"size": 300}')`);
  const out = await StorageCheck.run(h.pool, { deleteFiles: true });
  expect(out.deleted).toBe(2);
  expect(Supabase.deleteStorageFiles).toHaveBeenCalledWith(["a/orphan.jpg", "thumbs/a/orphan.jpg"]);
});
