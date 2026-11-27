// scripts/copy-storage-to-r2.js — One-off move of the Supabase bucket "listing-images" to Cloudflare R2, every object under the
// same key, so the database needs no rewrite. Idempotent: keys already in R2 are skipped. Uploads are serial (free plans).
// Prints counts only (never keys: they name agencies and brokers).
//   node --env-file=.env scripts/copy-storage-to-r2.js --dry-run
//   node --env-file=.env scripts/copy-storage-to-r2.js
"use strict";

const { createClient } = require("@supabase/supabase-js");
const { AwsClient } = require("aws4fetch");

const BUCKET = "listing-images";
const env = process.env;
const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"].filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing settings: ${missing.join(", ")}`);
  process.exit(1);
}
const dryRun = process.argv.includes("--dry-run");

const source = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }).storage.from(BUCKET);
const r2 = new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
const endpoint = `https://${env.R2_ACCOUNT_ID}${env.R2_JURISDICTION ? "." + env.R2_JURISDICTION : ""}.r2.cloudflarestorage.com`;
const objectUrl = (key) => `${endpoint}/${env.R2_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;

/** Every file under a folder, depth first; Supabase lists folders as entries without an id. */
async function* walk(prefix) {
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await source.list(prefix, { limit: PAGE, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`Listing failed: ${error.message}`);
    for (const e of data) {
      const key = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.id === null) yield* walk(key);
      else if (e.name !== ".emptyFolderPlaceholder") yield { key, type: e.metadata && e.metadata.mimetype };
    }
    if (data.length < PAGE) return;
  }
}

async function main() {
  const n = { found: 0, alreadyInR2: 0, copied: 0, wouldCopy: 0, failed: 0 };
  for await (const o of walk("")) {
    n.found++;
    if (n.found % 200 === 0) console.log(JSON.stringify(n));
    const head = await r2.fetch(objectUrl(o.key), { method: "HEAD" });
    if (head.ok) {
      n.alreadyInR2++;
      continue;
    }
    if (dryRun) {
      n.wouldCopy++;
      continue;
    }
    const { data, error } = await source.download(o.key);
    if (error || !data) {
      n.failed++;
      continue;
    }
    const res = await r2.fetch(objectUrl(o.key), {
      method: "PUT",
      body: Buffer.from(await data.arrayBuffer()),
      headers: { "Content-Type": o.type || data.type || "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable", "If-None-Match": "*" }
    });
    if (res.ok) n.copied++;
    else n.failed++;
  }
  console.log(JSON.stringify({ ...n, dryRun }));
  if (n.failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
