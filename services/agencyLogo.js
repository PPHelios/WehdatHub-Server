// services/agencyLogo.js — The agency logo (managers, the agency owner and admins): resized to a 512px PNG, stored, and linked on the agency.
// The website's Settings and the app both use this.
"use strict";

const crypto = require("crypto");
const sharp = require("sharp");
const Storage = require("../lib/supabase");
const { isManager } = require("../lib/authz");

/** { ok, url } | { error: 'forbidden' | 'bad' | 'failed' }. `file` is { buffer } from the upload. */
async function setLogo(pool, broker, file) {
  if (!isManager(broker)) return { error: "forbidden" };
  let png = null;
  try {
    png = file ? await sharp(file.buffer, { failOn: "error" }).rotate().resize(512, 512, { fit: "inside", withoutEnlargement: true }).png().toBuffer() : null;
  } catch {
    png = null;
  }
  if (!png) return { error: "bad" };
  const hash = crypto.createHash("sha256").update(png).digest("hex").slice(0, 12);
  const url = await Storage.uploadAgencyLogo(broker.agency_id, `${broker.agency_id}/brand/logo-${hash}.png`, png);
  if (!url) return { error: "failed" };
  await pool.query("UPDATE agencies SET logo_url = $2 WHERE id = $1", [broker.agency_id, url]);
  return { ok: true, url };
}

async function removeLogo(pool, broker) {
  if (!isManager(broker)) return { error: "forbidden" };
  await pool.query("UPDATE agencies SET logo_url = NULL WHERE id = $1", [broker.agency_id]);
  return { ok: true };
}

module.exports = { setLogo, removeLogo };
