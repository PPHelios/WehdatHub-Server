// api/avatar.js — The signed-in broker's own profile photo: PUT /me/avatar (multipart field "photo") and DELETE /me/avatar.
// Stored in memory only, re-encoded to a 512px JPEG and sent to Supabase Storage at avatars/<agency>/<broker>-<ts>.jpg.
"use strict";

const Supabase = require("../lib/supabase");
const { makeAvatarBuffer } = require("../lib/images");
const { logOperation } = require("../lib/db");
const { uploads } = require("../web/uploads");

const AVATAR = { name: "photo", maxCount: 1, accept: /^image\/(jpeg|png|webp)$/ };

function register(api, { pool }) {
  const upload = uploads([AVATAR], { maxMb: 2 });

  api.put("/me/avatar", upload, async (req, res) => {
    const b = req.session.broker;
    const file = req.files?.photo?.[0];
    if (!file) return res.status(422).json({ error: "photo_missing" });
    let jpeg;
    try {
      jpeg = await makeAvatarBuffer(file.buffer);
    } catch {
      return res.status(422).json({ error: "bad_image" });
    }
    const path = await Supabase.uploadListingImage(b.agency_id, `avatars/${b.agency_id}/${b.id}-${Date.now()}.jpg`, jpeg);
    if (!path) return res.status(503).json({ error: "storage_unavailable" });
    const old = (await pool.query("SELECT avatar_path FROM brokers WHERE id = $1 AND agency_id = $2", [b.id, b.agency_id])).rows[0]?.avatar_path;
    await pool.query("UPDATE brokers SET avatar_path = $3, avatar_updated_at = now() WHERE id = $1 AND agency_id = $2", [b.id, b.agency_id, path]);
    if (old) Supabase.deleteStorageFiles([old]).catch(() => {});
    logOperation(pool, { agency_id: b.agency_id, broker_id: b.id, operation_type: "app_avatar_set" });
    return res.json({ avatarUrl: Supabase.photoUrl(path) });
  });

  api.delete("/me/avatar", async (req, res) => {
    const b = req.session.broker;
    const old = (await pool.query("SELECT avatar_path FROM brokers WHERE id = $1 AND agency_id = $2", [b.id, b.agency_id])).rows[0]?.avatar_path;
    await pool.query("UPDATE brokers SET avatar_path = NULL, avatar_updated_at = now() WHERE id = $1 AND agency_id = $2", [b.id, b.agency_id]);
    if (old) Supabase.deleteStorageFiles([old]).catch(() => {});
    logOperation(pool, { agency_id: b.agency_id, broker_id: b.id, operation_type: "app_avatar_removed" });
    return res.json({ avatarUrl: null });
  });
}

module.exports = { register };
