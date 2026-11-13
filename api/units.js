// api/units.js — The agency's units for the app: a filtered, paginated list and one unit. Every read carries the
// visibility rule (lib/visibility). Owner contacts, commission, notes and exact location are NOT returned yet: they follow
// the unit privacy rules (services/unitPrivacy.js) and arrive with the unit screen.
"use strict";

const Vis = require("../lib/visibility");
const Store = require("../lib/listingStore");
const Storage = require("../lib/supabase");
const Deal = require("../domain/dealType");
const Authz = require("../lib/authz");
const Share = require("../lib/shareLinks");
const UnitPrivacy = require("../services/unitPrivacy");
const Owners = require("../services/unitOwners");
const Rights = require("../services/unitRights");
const Recipients = require("../services/linkRecipients");
const Flyer = require("../lib/flyer");
const RateLimit = require("../lib/rateLimit");
const ReadCaps = require("../lib/readCaps");
const { PROPERTY_TYPES } = require("../domain/fieldRules");
const { FURNISHING_STATUSES, FINISHING_STATUSES } = require("../domain/furnishingStatus");

const STATUSES = ["active", "sold", "archived"];
const MAX_LIMIT = 50;
const COLS = `listings.id, listings.code, listings.status, listings.title, listings.property_type, listings.listing_type, listings.price_value,
  listings.price_display, listings.area_value, listings.bedrooms, listings.bathrooms, listings.compound, listings.district, listings.city,
  listings.finishing, listings.furnishing, listings.floor_level, listings.is_ready, listings.delivery_year, listings.delivery_quarter,
  listings.down_payment_value, listings.installment_years, listings.installment_value, listings.confirmed_at, listings.updated_at, listings.created_at,
  listings.broker_id`;

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

function register(api, { pool }) {
  api.get("/units", async (req, res) => {
    const { broker } = req.session;
    const q = req.query;
    const status = oneOf(q.status, STATUSES) || "active";
    const type = oneOf(q.type, PROPERTY_TYPES);
    const furnishing = oneOf(q.furnishing, FURNISHING_STATUSES);
    const finishing = oneOf(q.finishing, FINISHING_STATUSES);
    const deal = Deal.clean(q.deal);
    const limit = Math.max(1, Math.min(parseInt(q.limit, 10) || 20, MAX_LIMIT));
    const offset = Math.max(0, Math.min(parseInt(q.offset, 10) || 0, 100000));
    if (offset > ReadCaps.maxOffset(broker, 100000)) return res.status(403).json({ error: "too_deep" });
    const args = [broker.agency_id];
    const where = ["listings.agency_id = $1"];
    const add = (sql, v) => {
      args.push(v);
      where.push(sql.split("?").join(`$${args.length}`));
    };
    if (q.mine === "1") add("listings.broker_id = ?", broker.id);
    if (q.compound) add("listings.compound = ?", String(q.compound).slice(0, 120));
    if (type) add("listings.property_type = ?", type);
    if (furnishing) add("listings.furnishing = ?", furnishing);
    if (finishing) add("listings.finishing = ?", finishing);
    if (deal) where.push(Deal.sql(deal, "listings"));
    const pmin = Deal.parseMoney(String(q.pmin || ""));
    const pmax = Deal.parseMoney(String(q.pmax || ""));
    if (pmin) add("listings.price_value >= ?", pmin);
    if (pmax) add("listings.price_value <= ?", pmax);
    // "Units to check" (Today's card): active units nobody has confirmed for 21 days.
    if (q.old === "1") {
      where.push("listings.inventory_type IS DISTINCT FROM 'developer_model'");
      add("COALESCE(listings.confirmed_at, listings.updated_at, listings.created_at) < now() - (?::int * interval '1 day')", 21);
    }
    // Not updated for N days (data entry's "stale" filter).
    const staleDays = parseInt(q.staleDays, 10);
    if (staleDays >= 1 && staleDays <= 3650) add("COALESCE(listings.updated_at, listings.created_at) < now() - (?::int * interval '1 day')", staleDays);
    const bedrooms = parseInt(q.bedrooms, 10);
    if (bedrooms >= 0 && bedrooms <= 20) add("listings.bedrooms = ?", bedrooms);
    const code = String(q.q || "").trim().slice(0, 40);
    if (code) add("(listings.code ILIKE '%' || ? || '%' OR listings.developer_unit_code ILIKE '%' || ? || '%' OR listings.compound ILIKE '%' || ? || '%')", code.replace(/[%_\\]/g, (c) => `\\${c}`));
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

  api.get("/units/:code", async (req, res) => {
    const { broker } = req.session;
    // findByCode carries the visibility rule: a private unit is a 404 for everyone but the agency owner.
    const found = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!found) return res.status(404).json({ error: "not_found" });
    // Photos marked as documents or unrelated (contracts, receipts, screenshots) are only for managers and the unit's own broker.
    const docsToo = Authz.isManager(broker) || found.broker_id === broker.id;
    const images = (await pool.query(`SELECT id, url, position FROM listing_images WHERE listing_id = $1 AND agency_id = $2${docsToo ? "" : " AND (role IS NULL OR role NOT IN ('document', 'unrelated'))"} ORDER BY position`, [found.id, broker.agency_id])).rows;
    return res.json({
      ...unitView(found),
      mine: found.broker_id === broker.id,
      canEdit: Authz.canEdit(broker, found) && (await Rights.mayWrite(pool, broker)),
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
    const gate = await RateLimit.hit(pool, `flyer:broker:${broker.id}`, RateLimit.LIMITS.searchBroker);
    if (!gate.allowed) return res.status(429).set("Retry-After", String(gate.retryAfterSec)).json({ error: "rate_limited" });
    const out = await Flyer.flyerUrlFor(pool, broker, found, { theme: req.body?.theme === "light" ? "light" : "dark", lang: broker.preferred_lang === "en" ? "en" : "ar" });
    if (out.error) return res.status(out.error === "busy" ? 503 : 502).json({ error: out.error });
    return res.json({ url: out.url });
  });

  // A client link for an active unit: the page shows photos and specs only, and the broker is alerted when it is opened.
  api.post("/units/:code/share-link", async (req, res) => {
    const { broker } = req.session;
    const found = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!found || !Authz.canView(broker, found)) return res.status(404).json({ error: "not_found" });
    if (found.status !== "active") return res.status(409).json({ error: "not_active" });
    const lang = req.body?.lang === "en" ? "en" : "ar";
    // Who it goes to: a lead (L-0042) or a mobile number, same as the website and Telegram; empty means no recipient.
    const recipient = await Recipients.resolveRecipient(pool, broker, req.body && req.body.to);
    if (recipient.error) return res.status(422).json({ error: recipient.error });
    const { url } = await Share.createShareLink(pool, broker, found, { channel: "web", lang, recipient, source: "web" });
    return res.json({ url, recipientPhone: recipient.phone || null, leadLinked: Boolean(recipient.leadId) });
  });
}

module.exports = { register, unitView };
