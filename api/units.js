// api/units.js — The agency's units for the app: a filtered, paginated list and one unit. Every read carries the
// visibility rule (lib/visibility). Owner contacts, commission, notes and exact location are NOT returned yet: they follow
// the unit privacy rules (services/unitPrivacy.js) and arrive with the unit screen.
"use strict";

const Vis = require("../lib/visibility");
const Store = require("../lib/listingStore");
const { phaseOf, PHASE_NAME_COLS } = require("../lib/unitPhase");
const Storage = require("../lib/supabase");
const UnitFilters = require("../domain/unitFilters");
const Authz = require("../lib/authz");
const Credits = require("../services/credits");
const Describe = require("../domain/describe");
const { logOperation } = require("../lib/db");
const { normalizeCode } = require("../domain/searchQuery");
const Share = require("../lib/shareLinks");
const UnitPrivacy = require("../services/unitPrivacy");
const Owners = require("../services/unitOwners");
const Rights = require("../services/unitRights");
const Recipients = require("../services/linkRecipients");
const Flyer = require("../lib/flyer");
const RateLimit = require("../lib/rateLimit");
const ReadCaps = require("../lib/readCaps");

const STATUSES = ["active", "sold", "archived"];
const MAX_LIMIT = 50;
const COLS = `listings.id, listings.code, listings.status, listings.title, listings.property_type, listings.listing_type, listings.price_value,
  listings.price_display, listings.area_value, listings.bedrooms, listings.bathrooms, listings.compound, listings.district, listings.city,
  listings.finishing, listings.furnishing, listings.floor_level, listings.is_ready, listings.delivery_year, listings.delivery_quarter,
  listings.down_payment_value, listings.installment_years, listings.installment_value, listings.confirmed_at, listings.updated_at, listings.created_at,
  listings.broker_id, ${PHASE_NAME_COLS}`;

const oneOf = (v, list) => (list.includes(String(v || "")) ? String(v) : "");
const photoOf = (url) => (url ? Storage.photoUrl(url) : null);
const thumbOf = (url) => (url ? Storage.thumbUrl(url) : null);

/** A row for the app: plain names, numbers as numbers, photo as a full URL. */
function unitView(r) {
  return {
    id: r.id,
    code: r.code,
    status: r.status,
    title: r.title,
    propertyType: r.property_type,
    dealType: r.listing_type,
    price: r.price_value === null ? null : Number(r.price_value),
    priceText: r.price_display,
    area: r.area_value === null ? null : Number(r.area_value),
    bedrooms: r.bedrooms,
    bathrooms: r.bathrooms,
    compound: r.compound,
    compoundEn: r.compound_en || r.details?.compound_en || null,
    phase: r.phase_ar || r.phase_en || null,
    phaseEn: r.phase_en || r.phase_ar || null,
    district: r.district,
    city: r.city,
    finishing: r.finishing,
    furnishing: r.furnishing,
    floor: r.floor_level,
    isReady: r.is_ready,
    delivery: r.delivery_year ? { year: r.delivery_year, quarter: r.delivery_quarter } : null,
    downPayment: r.down_payment_value === null ? null : Number(r.down_payment_value),
    installmentYears: r.installment_years,
    installmentValue: r.installment_value === null ? null : Number(r.installment_value),
    confirmedAt: r.confirmed_at,
    updatedAt: r.updated_at
  };
}

const SaveKeys = require("../lib/saveKeys");

function register(api, { pool }) {
  api.get("/units", async (req, res) => {
    const { broker } = req.session;
    const q = req.query;
    const status = oneOf(q.status, STATUSES) || "active";
    const limit = Math.max(1, Math.min(parseInt(q.limit, 10) || 20, MAX_LIMIT));
    const offset = Math.max(0, Math.min(parseInt(q.offset, 10) || 0, 100000));
    if (offset > ReadCaps.maxOffset(broker, 100000)) return res.status(403).json({ error: "too_deep" });
    const args = [broker.agency_id];
    const where = ["listings.agency_id = $1"];
    // Filters: one reader for the website and the app (domain/unitFilters.js).
    const f = UnitFilters.read(q, { isOwner: Authz.isAgencyOwner(broker), status });
    UnitFilters.appendTo(where, args, UnitFilters.conditions(f, { brokerId: broker.id, alias: "listings", compound: q.compound ? String(q.compound).slice(0, 120) : "" }));
    if (q.missingPhotos === "true" || q.missingPhotos === "1") {
      where.push("NOT EXISTS (SELECT 1 FROM listing_images i WHERE i.listing_id = listings.id AND i.agency_id = listings.agency_id AND (i.role IS NULL OR i.role NOT IN ('document', 'unrelated')))");
    }
    // The three status counts use every filter except the status itself, so the tabs show their numbers from the start.
    const byStatus = (await pool.query(`SELECT listings.status AS s, count(*)::int AS n FROM listings WHERE ${Vis.units("listings")} AND ${where.join(" AND ")} AND listings.status IN ('active', 'sold', 'archived') GROUP BY listings.status`, args)).rows;
    const counts = { active: 0, sold: 0, archived: 0 };
    for (const r of byStatus) counts[r.s] = r.n;
    args.push(status);
    const cond = `${where.join(" AND ")} AND listings.status = $${args.length}`;
    const total = counts[status];
    const { rows } = await pool.query(
      `SELECT ${COLS},
              (SELECT li.url FROM listing_images li WHERE li.listing_id = listings.id AND li.agency_id = listings.agency_id ORDER BY li.position LIMIT 1) AS photo
       FROM listings WHERE ${Vis.units("listings")} AND ${cond}
       ORDER BY listings.confirmed_at DESC NULLS LAST, listings.created_at DESC, listings.id DESC LIMIT ${limit} OFFSET ${offset}`,
      args
    );
    const cap = await ReadCaps.takeListRows(pool, broker, "units", rows.length);
    if (!cap.allowed) return res.set("Retry-After", String(cap.retryAfterSec)).status(429).json({ error: "daily_cap" });
    return res.json({
      total,
      counts,
      limit,
      offset,
      items: rows.map((r) => ({ ...unitView(r), mine: r.broker_id === broker.id, photo: photoOf(r.photo), thumb: thumbOf(r.photo) }))
    });
  });

  // Compound suggestions as the person types: name and how many units in it (active, visible to this person).
  api.get("/units/compounds", async (req, res) => {
    const { broker } = req.session;
    const text = String(req.query.q || "").trim().slice(0, 60);
    const args = [broker.agency_id];
    let like = "";
    if (text) {
      args.push(text.replace(/[%_\\]/g, (c) => "\\" + c));
      like = "AND listings.compound ILIKE '%' || $2 || '%'";
    }
    const { rows } = await pool.query(
      `SELECT listings.compound AS name, count(*)::int AS n FROM listings
        WHERE ${Vis.units("listings")} AND listings.agency_id = $1 AND listings.status = 'active' AND listings.compound IS NOT NULL AND listings.compound <> '' ${like}
        GROUP BY listings.compound ORDER BY n DESC, listings.compound LIMIT 12`,
      args
    );
    return res.json({ items: rows });
  });

  // "Is it saved?": the app asks this when a save has had no answer for a minute. Read only.
  api.get("/units/save-status", async (req, res) => {
    const key = SaveKeys.keyOf({ save_key: String(req.query.key || "") });
    const code = key ? await SaveKeys.lookup(pool, req.session.broker.agency_id, key) : null;
    res.set("Cache-Control", "no-store");
    return res.json(code ? { saved: true, code } : { saved: false });
  });

  // The codes the posts of a WhatsApp chat write (one call after the app has read the zip): which already belong to a unit
  // the person may change (an update, with its photo count), which are free (new), which belong to a unit they may not
  // change (taken; nothing else about it is shown). Same answer as the website's import page. Also the AI credit cost of one post.
  api.post("/units/code-check", async (req, res) => {
    const { broker } = req.session;
    const t0 = Date.now();
    const wanted = [...new Set((Array.isArray(req.body?.codes) ? req.body.codes : []).map((c) => String(c || "").trim().slice(0, 40)).filter(Boolean))].slice(0, 200);
    // Several spellings can fold to one code_norm (HP-12, hp-12, #HP-12): each of them gets the answer.
    const byNorm = new Map();
    for (const c of wanted) {
      const n = normalizeCode(c);
      if (!byNorm.has(n)) byNorm.set(n, []);
      byNorm.get(n).push(c);
    }
    const put = (n, v) => { for (const c of byNorm.get(n) || []) out[c] = v; };
    const out = {};
    if (byNorm.size) {
      const { rows } = await pool.query(
        `SELECT l.id, l.code, l.code_norm, l.agency_id, l.broker_id, l.is_private, l.status,
                (SELECT count(*)::int FROM listing_images i WHERE i.listing_id = l.id) AS photos
           FROM listings l WHERE ${Vis.units("l")} AND l.agency_id = $1 AND l.code_norm = ANY($2::text[])`,
        [broker.agency_id, [...byNorm.keys()]]
      );
      for (const l of rows) put(l.code_norm, Authz.canEdit(broker, l) ? { state: "update", code: l.code, photos: l.photos, status: l.status } : { state: "taken" });
      const rest = [...byNorm.keys()].filter((n) => !out[byNorm.get(n)[0]]);
      if (rest.length) {
        const { rows: hidden } = await pool.query("SELECT code_norm FROM listings WHERE agency_id = $1 AND code_norm = ANY($2::text[]) /* vis:exempt */", [broker.agency_id, rest]);
        for (const l of hidden) put(l.code_norm, { state: "taken" });
      }
    }
    for (const c of wanted) if (!out[c]) out[c] = { state: "new" };
    res.set("Cache-Control", "no-store");
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "chat_import_codes", total_duration_ms: Date.now() - t0, metadata: { channel: "app", codes: wanted.length, update: Object.values(out).filter((x) => x.state === "update").length, taken: Object.values(out).filter((x) => x.state === "taken").length, fresh: Object.values(out).filter((x) => x.state === "new").length } });
    return res.json({ codes: out, max_photos: 15, ai_cost: Credits.costOf("chat_post") });
  });

  api.get("/units/:code/matching-leads", async (req, res) => {
    const { broker } = req.session;
    if (!(await RateLimit.apiGate(pool, res, `reverse-match:broker:${broker.id}`, { limit: 5, windowSec: 60 }))) return;
    const found = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!found) return res.status(404).json({ error: "not_found" });
    const { whoWants } = require("../services/leadRequests");
    const { refLabel } = require("../domain/leadCard");
    const result = await whoWants(pool, broker, found, { cap: 50, lang: broker.preferred_lang === "en" ? "en" : "ar" });
    return res.json({ partial: Boolean(result.partial), items: result.leads.map((lead) => ({
      ref: refLabel(lead.ref), name: lead.name, reason: lead.reason
    })) });
  });
  api.get("/units/:code", async (req, res) => {
    const { broker } = req.session;
    // findByCode carries the visibility rule: a private unit is a 404 for everyone but the agency owner.
    const found = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!found) return res.status(404).json({ error: "not_found" });
    // Photos marked as documents or unrelated (contracts, receipts, screenshots) are only for managers and the unit's own broker.
    const docsToo = Authz.isManager(broker) || found.broker_id === broker.id;
    const [{ rows: images }, mayWrite] = await Promise.all([
      pool.query(`SELECT id, url, position FROM listing_images WHERE listing_id = $1 AND agency_id = $2${docsToo ? "" : " AND (role IS NULL OR role NOT IN ('document', 'unrelated'))"} ORDER BY position`, [found.id, broker.agency_id]),
      Authz.canEdit(broker, found) && Rights.mayWrite(pool, broker)
    ]);
    const canEditColleague = Authz.canEditSharedUnit(broker, found) && await Rights.mayWrite(pool, broker);
    return res.json({
      ...unitView(found),
      ...(await phaseOf(pool, found.subzone_id)),
      mine: found.broker_id === broker.id,
      canEdit: Boolean(mayWrite),
      canDelete: Authz.canDeleteUnit(broker, found),
      canEditColleague,
      ...(canEditColleague ? { colleagueEdit: { version: found.version, description: found.description || "" } } : {}),
      features: found.feature_keys || [],
      images: images.map((i) => ({ id: i.id, url: Storage.photoUrl(i.url), position: i.position }))
    });
  });

  // The owner's name and number, only for a broker who may see this unit's secret details (the agency's switch, the
  // unit's own broker, managers, or a granted request). Anyone else gets 403 and the app hides the buttons.
  api.get("/units/:code/contact", async (req, res) => {
    const { broker } = req.session;
    const found = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!found) return res.status(404).json({ error: "not_found" });
    if (!(await UnitPrivacy.canSee(pool, broker, found))) {
      const state = (await UnitPrivacy.askStates(pool, broker, [found])).get(found.id) || "ask";
      return res.status(403).json({ error: "hidden", access: state });
    }
    const owner = found.owner_id ? await Owners.getFor(pool, broker, found.owner_id) : null;
    const d = found.details || {};
    const phone = owner?.phones?.[0] || d.owner_phone || null;
    if (phone) {
      const cap = await ReadCaps.takeOwnerPhones(pool, broker, 1, { channel: "app", ref: found.code });
      if (!cap.allowed) return res.set("Retry-After", String(cap.retryAfterSec)).status(429).json({ error: "daily_cap" });
    }
    return res.json({ name: owner?.name || d.owner_name || null, phone: phone ? String(phone) : null });
  });

  // Ask the managers to see this unit's hidden details (owner, address, pin). They answer on the website.
  api.post("/units/:code/access-request", async (req, res) => {
    const { broker } = req.session;
    const found = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!found) return res.status(404).json({ error: "not_found" });
    const out = await UnitPrivacy.requestAccess(pool, broker, found);
    return res.json({ ok: true, already: Boolean(out.already), access: out.already ? "granted" : "pending" });
  });

  // The unit's flyer as an image link (made on the first call, then cached). Nothing is sent to anyone.
  api.post("/units/:code/flyer", async (req, res) => {
    const { broker } = req.session;
    const found = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!found || !Authz.canView(broker, found)) return res.status(404).json({ error: "not_found" });
    if (!(await RateLimit.apiGate(pool, res, `flyer:broker:${broker.id}`, RateLimit.LIMITS.searchBroker))) return;
    const out = await Flyer.flyerUrlFor(pool, broker, found, { theme: req.body?.theme === "light" ? "light" : "dark", lang: req.body?.lang === "en" || req.body?.lang === "ar" ? req.body.lang : broker.preferred_lang === "en" ? "en" : "ar", unbranded: req.body?.unbranded === true, planState: req.planState });
    if (out.error) return res.status(out.error === "busy" ? 503 : 502).json({ error: out.error });
    return res.json({ url: out.url });
  });

  // The client message for a unit in one language (the facts are written by the parser): the app shows it in a box to edit before sending.
  api.get("/units/:code/message", async (req, res) => {
    const { broker } = req.session;
    const found = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!found || !Authz.canView(broker, found)) return res.status(404).json({ error: "not_found" });
    return res.json({ message: Describe.clientCopy(found, broker, { lang: req.query.lang === "en" ? "en" : "ar" }) });
  });

  // A client link for an active unit: the page shows photos and specs only, and the broker is alerted when it is opened.
  api.post("/units/:code/share-link", async (req, res) => {
    const { broker } = req.session;
    const found = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!found || !Authz.canView(broker, found)) return res.status(404).json({ error: "not_found" });
    const lang = req.body?.lang === "en" ? "en" : "ar";
    // Who it goes to: a lead (L-0042) or a mobile number, same as the website and Telegram; empty means no recipient.
    const recipient = await Recipients.resolveRecipient(pool, broker, req.body && req.body.to);
    if (recipient.error) return res.status(422).json({ error: recipient.error });
    const { url } = await Share.createShareLink(pool, broker, found, { channel: "web", lang, recipient, source: "web", planState: req.planState });
    return res.json({ url, recipientPhone: recipient.phone || null, leadLinked: Boolean(recipient.leadId) });
  });
}

module.exports = { register, unitView };
