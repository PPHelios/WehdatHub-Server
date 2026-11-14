// web/routes/matchPhotos.js — Match photos (managers): the browser reads a WhatsApp chat export zip itself (see
// web/static/chatphotos.js), matches photos to units, shrinks them and sends them one at a time. This file is the
// server half: the unit codes to match against, one photo onto a unit, and the posts → group import path
// (no codes: the posts are read like a group import and the photos go with them).
"use strict";

const crypto = require("crypto");
const Swallow = require("../../lib/swallow");
const express = require("express");
const Supabase = require("../../lib/supabase");
const AI = require("../../lib/ai");
const RateLimit = require("../../lib/rateLimit");
const Store = require("../../lib/listingStore");
const Edits = require("../../lib/edits");
const Authz = require("../../lib/authz");
const Vis = require("../../lib/visibility");
const { logOperation } = require("../../lib/db");
const { normalizeImageBuffer, MAX_PHOTOS } = require("../../lib/images");
const PhotoHash = require("../../services/photoHash");
const Imports = require("../../services/imports");
const Chat = require("../../domain/chatExport");
const AiBlock = require("../../lib/aiBlock");
const ChatPlan = require("../../services/chatPlan");
const ChatLog = require("../../services/chatParseLog");
const Session = require("../session");
const { uploads } = require("../uploads");

const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const ONE_PHOTO = [{ name: "photo", maxCount: 1, accept: /^image\// }];
// The browser shrinks every photo to about 1600 px before sending, so 8 MB is already generous.
const uploadPhoto = uploads(ONE_PHOTO, { maxMb: 8 });
for (const re of [/^\/import\/match\/unit\/[^/]+\/photo$/, /^\/import\/match\/[0-9a-f-]{36}\/photo\/\d+$/, /^\/import\/match\/p\/[0-9a-f-]{36}\/photo\/\d+$/]) Session.allowMultipart(re);

// Hundreds of photos a run: its own bucket (the generic upload limit is 30 per 10 minutes).
const PHOTO_LIMIT = { limit: 3000, windowSec: 3600 };

function register(web, { pool }) {
  const managersOnly = (req, res, next) => (Authz.isManager(req.session.broker) ? next() : res.status(403).json({ error: "managers_only" }));
  const gate = async (req, res, next) => {
    const hit = await RateLimit.hit(pool, `matchphoto:broker:${req.session.broker.id}`, PHOTO_LIMIT);
    if (hit.allowed) return next();
    res.set("Retry-After", String(hit.retryAfterSec));
    return res.status(429).json({ error: "rate", retry_after: hit.retryAfterSec });
  };

  // The unit codes of the agency (what the browser matches against) with how many photos each already has.
  web.get("/import/match/units", managersOnly, async (req, res) => {
    const { rows } = await pool.query(
      `SELECT l.code, (SELECT count(*)::int FROM listing_images i WHERE i.listing_id = l.id) AS photos
         FROM listings l WHERE ${Vis.units("l")} AND l.agency_id = $1 ORDER BY l.code LIMIT 20000`,
      [req.session.broker.agency_id]
    );
    res.set("Cache-Control", "no-store");
    return res.json({ units: rows, max_photos: MAX_PHOTOS });
  });

  // One photo onto the unit with this code: shrunk copy from the browser, normalised again here, stored, hashed.
  // answers { ok } | { dup: true } (the unit already has this picture) | { full: true } | { missing: true }
  web.post("/import/match/unit/:code/photo", managersOnly, gate, uploadPhoto, async (req, res) => {
    const { broker } = req.session;
    const file = (req.files?.photo || [])[0];
    if (!file) return res.status(400).json({ error: "no_photo" });
    const code = String(req.params.code || "").slice(0, 80);
    const listing = await Store.findByCode(pool, broker.agency_id, code);
    if (!listing || !Authz.canEdit(broker, listing)) return res.status(404).json({ missing: true });
    let jpeg;
    try {
      jpeg = await normalizeImageBuffer(file.buffer);
    } catch {
      return res.status(422).json({ error: "unreadable" });
    }
    const hash = await PhotoHash.hashImage(jpeg);
    const { rows: have } = await pool.query("SELECT phash::text AS phash FROM listing_images WHERE listing_id = $1 AND agency_id = $2", [listing.id, broker.agency_id]);
    if (have.length >= MAX_PHOTOS) return res.json({ full: true });
    if (hash && have.some((r) => r.phash && PhotoHash.distance(r.phash, hash) <= PhotoHash.MAX_DISTANCE)) return res.json({ dup: true });
    const url = await Supabase.uploadListingImage(broker.agency_id, `listings/${broker.agency_id}/match/${listing.id}/${Date.now()}_${crypto.randomBytes(3).toString("hex")}.jpg`, jpeg);
    if (!url) return res.status(502).json({ error: "storage" });
    const out = await Edits.withCodeLock(pool, broker.agency_id, listing.code, async (client) => {
      const current = await Store.findByCode(client, broker.agency_id, listing.code, { forUpdate: true });
      if (!current || !Authz.canEdit(broker, current)) return { rollback: true, missing: true };
      const { rows } = await client.query("SELECT count(*)::int AS n FROM listing_images WHERE listing_id = $1", [current.id]);
      if (rows[0].n >= MAX_PHOTOS) return { rollback: true, full: true };
      await Store.addPhotos(client, current, [url]);
      await PhotoHash.saveHashes(client, broker.agency_id, new Map([[url, hash]]));
      return { ok: true };
    });
    if (!out.ok) {
      Supabase.deleteStorageFiles([url]).catch(Swallow.logged(pool, "matchPhotos.cleanup"));
      return res.status(out.missing ? 404 : 200).json(out.missing ? { missing: true } : { full: true });
    }
    const same = hash ? (await PhotoHash.sameAs(pool, broker.agency_id, [hash], { excludeListingId: listing.id })).get(hash) : null;
    return res.json({ ok: true, ...(same ? { same_as: same } : {}) });
  });

  // No codes: the posts the browser found become a group import (read in the background like a pasted one); the
  // photos follow one by one on /import/match/:id/photo/:n and the review page is the usual group review.
  web.post("/import/match/start", managersOnly, express.json({ limit: "1mb" }), async (req, res) => {
    const { broker } = req.session;
    const gateHit = await RateLimit.hit(pool, `upload:broker:${broker.id}`, RateLimit.LIMITS.uploadBroker);
    if (!gateHit.allowed) return res.status(429).json({ error: "rate", retry_after: gateHit.retryAfterSec });
    const sent = Array.isArray(req.body?.posts) ? req.body.posts : [];
    const posts = sent
      .slice(0, Chat.MAX_POSTS)
      .map((p) => ({ sender: String(p?.sender || "").slice(0, 80) || null, at: String(p?.at || "").slice(0, 40) || null, text: String(p?.text || "").slice(0, 4000), photos: [] }))
      .filter((p) => p.text.trim().length >= 10);
    if (!posts.length) return res.status(422).json({ error: "no_posts" });
    for (const p of posts) p.hash = crypto.createHash("sha1").update(p.text).digest("hex").slice(0, 16);
    const lang = langOf(req);
    const id = await Imports.startGroupImport(pool, broker, posts, {
      AI,
      ctx: { pool, broker, agency: req.session.agency, lang },
      lang,
      filename: String(req.body?.filename || "").slice(0, 120) || null
    });
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "web_import_plan", metadata: { kind: "group_browser", posts: posts.length } });
    return res.json({ id, posts: posts.length });
  });

  // One photo onto post n of that group import (it goes on the unit when the post is applied).
  web.post("/import/match/:id/photo/:n", managersOnly, gate, uploadPhoto, async (req, res) => {
    const { broker } = req.session;
    const file = (req.files?.photo || [])[0];
    const n = Number(req.params.n);
    if (!file || !Number.isInteger(n) || n < 0) return res.status(400).json({ error: "no_photo" });
    const imp = await Imports.loadImport(pool, broker, req.params.id);
    const posts = imp?.payload?.posts;
    if (!imp || imp.kind !== "group" || !["processing", "ready"].includes(imp.status) || !posts?.[n]) return res.status(404).json({ missing: true });
    if ((posts[n].photos || []).length >= MAX_PHOTOS) return res.json({ full: true });
    let jpeg;
    try {
      jpeg = await normalizeImageBuffer(file.buffer);
    } catch {
      return res.status(422).json({ error: "unreadable" });
    }
    const hash = await PhotoHash.hashImage(jpeg);
    const url = await Supabase.uploadListingImage(broker.agency_id, `listings/${broker.agency_id}/imports/${imp.id}/${n}_${crypto.randomBytes(4).toString("hex")}.jpg`, jpeg);
    if (!url) return res.status(502).json({ error: "storage" });
    const photo = { url, hash };
    const twin = hash ? posts.findIndex((p, k) => k < n && (p.photos || []).some((o) => o.hash && PhotoHash.distance(o.hash, hash) <= PhotoHash.MAX_DISTANCE)) : -1;
    if (twin >= 0) photo.twin = twin;
    const same = hash ? (await PhotoHash.sameAs(pool, broker.agency_id, [hash])).get(hash) : null;
    if (same) photo.same_as = same;
    const { rowCount } = await pool.query(
      `UPDATE web_imports SET payload = jsonb_set(payload, ARRAY['posts', $2::text, 'photos'], COALESCE(payload #> ARRAY['posts', $2::text, 'photos'], '[]'::jsonb) || $3::jsonb)
        WHERE id = $1 AND agency_id = $4 AND broker_id = $5 AND kind = 'group' AND status IN ('processing', 'ready')
          AND jsonb_array_length(COALESCE(payload #> ARRAY['posts', $2::text, 'photos'], '[]'::jsonb)) < $6`,
      [imp.id, String(n), JSON.stringify([photo]), broker.agency_id, broker.id, MAX_PHOTOS]
    );
    if (!rowCount) {
      Supabase.deleteStorageFiles([url]).catch(Swallow.logged(pool, "matchPhotos.cleanup"));
      return res.json({ full: true });
    }
    return res.json({ ok: true, ...(twin >= 0 ? { twin: true } : {}), ...(same ? { same_as: same } : {}) });
  });
  // ---- The chat import plan: posts read by the parser (AI only where it is missing something), planned like Excel. ----

  web.post("/import/match/plan", managersOnly, express.json({ limit: "1mb" }), async (req, res) => {
    const { broker } = req.session;
    const lang = langOf(req);
    const t0 = Date.now();
    const hit = await RateLimit.hit(pool, `upload:broker:${broker.id}`, RateLimit.LIMITS.uploadBroker);
    if (!hit.allowed) return res.status(429).json({ error: "rate", retry_after: hit.retryAfterSec });
    const sent = Array.isArray(req.body?.posts) ? req.body.posts : [];
    const posts = sent
      .slice(0, ChatPlan.MAX_POSTS)
      .map((p) => ({ sender: String(p?.sender || "").slice(0, 80) || null, at: String(p?.at || "").slice(0, 40) || null, text: String(p?.text || "").slice(0, 4000) }))
      .filter((p) => p.text.trim().length >= 10);
    if (!posts.length) return res.status(422).json({ error: "no_posts" });
    try {
      const out = await ChatPlan.planChat(pool, broker, posts, { AI, ctx: { pool, broker, agency: req.session.agency, lang }, lang, filename: String(req.body?.filename || "").slice(0, 120) || null });
      logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "web_import_plan", total_duration_ms: Date.now() - t0, metadata: { kind: "chat", posts: posts.length, ai: out.ai, ai_blocked: out.aiBlocked, counts: out.counts } });
      return res.json({ id: out.id, posts: out.posts, ai: out.ai, ...(out.aiBlocked ? { ai_blocked: out.aiBlocked, message: AiBlock.text(out.aiBlocked, lang) } : {}) });
    } catch (err) {
      logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "web_import_plan", status: "error", error_code: "chat_plan_failed", total_duration_ms: Date.now() - t0, metadata: { kind: "chat", posts: posts.length, message: String(err.message || "").slice(0, 120) } });
      return res.status(500).json({ error: "plan_failed", message: lang === "en" ? "Could not read the posts. Try again." : "مقدرناش نقرا البوستات. جرب تاني." });
    }
  });

  // One photo onto row n of that plan (it goes on the unit when the row is applied; the review lets the person pick).
  web.post("/import/match/p/:id/photo/:row", managersOnly, gate, uploadPhoto, async (req, res) => {
    const { broker } = req.session;
    const file = (req.files?.photo || [])[0];
    const row = Number(req.params.row);
    if (!file || !Number.isInteger(row) || row < 1) return res.status(400).json({ error: "no_photo" });
    const imp = await Imports.loadImport(pool, broker, req.params.id);
    const have = imp?.payload?.photos?.[String(row)] || [];
    if (!imp || imp.kind !== "excel" || imp.payload?.source !== "chat" || imp.status !== "ready" || !(imp.payload.rows || []).some((r) => r.rowNumber === row)) return res.status(404).json({ missing: true });
    if (have.length >= MAX_PHOTOS) return res.json({ full: true });
    let jpeg;
    try {
      jpeg = await normalizeImageBuffer(file.buffer);
    } catch {
      return res.status(422).json({ error: "unreadable" });
    }
    const hash = await PhotoHash.hashImage(jpeg);
    if (hash && have.some((o) => o.hash && PhotoHash.distance(o.hash, hash) <= PhotoHash.MAX_DISTANCE)) return res.json({ dup: true });
    const url = await Supabase.uploadListingImage(broker.agency_id, `listings/${broker.agency_id}/imports/${imp.id}/${row}_${crypto.randomBytes(4).toString("hex")}.jpg`, jpeg);
    if (!url) return res.status(502).json({ error: "storage" });
    const same = hash ? (await PhotoHash.sameAs(pool, broker.agency_id, [hash])).get(hash) : null;
    const photo = { url, hash, ...(same ? { same_as: same } : {}) };
    const { rowCount } = await pool.query(
      `UPDATE web_imports SET payload = jsonb_set(payload, ARRAY['photos', $2::text], COALESCE(payload #> ARRAY['photos', $2::text], '[]'::jsonb) || $3::jsonb, true)
        WHERE id = $1 AND agency_id = $4 AND broker_id = $5 AND status = 'ready'
          AND jsonb_array_length(COALESCE(payload #> ARRAY['photos', $2::text], '[]'::jsonb)) < $6`,
      [imp.id, String(row), JSON.stringify([photo]), broker.agency_id, broker.id, MAX_PHOTOS]
    );
    if (!rowCount) {
      Supabase.deleteStorageFiles([url]).catch(Swallow.logged(pool, "matchPhotos.cleanup"));
      return res.json({ full: true });
    }
    return res.json({ ok: true, ...(same ? { same_as: same } : {}) });
  });

  // A unit's photos (to choose which to keep when more than 15 would be there), and removing some of them.
  web.get("/import/match/unit/:code/photos", managersOnly, async (req, res) => {
    const { broker } = req.session;
    const listing = await Store.findByCode(pool, broker.agency_id, String(req.params.code || "").slice(0, 80));
    if (!listing || !Authz.canEdit(broker, listing)) return res.status(404).json({ missing: true });
    const { rows } = await pool.query("SELECT id, url FROM listing_images WHERE listing_id = $1 AND agency_id = $2 AND url <> '' ORDER BY position, id", [listing.id, broker.agency_id]);
    res.set("Cache-Control", "no-store");
    return res.json({ photos: rows });
  });

  web.post("/import/match/unit/:code/photos/remove", managersOnly, express.json({ limit: "20kb" }), async (req, res) => {
    const { broker } = req.session;
    const listing = await Store.findByCode(pool, broker.agency_id, String(req.params.code || "").slice(0, 80));
    if (!listing || !Authz.canEdit(broker, listing)) return res.status(404).json({ missing: true });
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter((x) => /^[0-9a-f-]{36}$/.test(String(x))).slice(0, 15);
    const urls = await Store.removePhotos(pool, listing, ids);
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, listing_code: listing.code, operation_type: "chat_import_step", metadata: { step: "remove_photos", count: urls.length } });
    return res.json({ removed: urls.length });
  });

  // Steps timed and checked in the browser (read, match, shrink, upload): saved with their time and error.
  web.post("/import/match/log", managersOnly, express.json({ limit: "20kb" }), async (req, res) => {
    await ChatLog.steps(pool, req.session.broker, Array.isArray(req.body?.steps) ? req.body.steps : []);
    return res.json({ ok: true });
  });
}

module.exports = { register };
