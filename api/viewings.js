// api/viewings.js — Viewings and sent links for the app: set a viewing on a lead (nothing is sent to the client; the app gets
// the message text and the client's link so the broker can send it or not), the broker's calendar, and the links the broker
// has shared. Same rules as the website: services/viewings.js, lib/visibility, canEditLead.
"use strict";

const Leads = require("../services/leads");
const Stages = require("../domain/leadStages");
const Viewings = require("../services/viewings");
const Store = require("../lib/listingStore");
const RateLimit = require("../lib/rateLimit");
const Card = require("../domain/leadCard");
const Vis = require("../lib/visibility");
const { leadView } = require("./leads");

const PAGE = 30;
const ERRORS = { follow_up_time: 422, past: 422, unit_not_found: 422, forbidden: 403, not_found: 404 };
const iso = (d) => (d ? new Date(d).toISOString() : null);

function register(api, { pool }) {
  // Set a viewing: date and time (ISO), a unit code (optional), a place (optional). The answer carries the client's message
  // and link; the app shows the message under an info button and only sends it when the broker chooses to.
  api.post("/leads/:ref/viewing", async (req, res) => {
    const { broker } = req.session;
    if (!(await RateLimit.apiGate(pool, res, `crm_write:broker:${broker.id}`, RateLimit.LIMITS.crmWriteBroker))) return;
    const lead = await Leads.getLead(pool, broker, req.params.ref);
    if (!lead) return res.status(404).json({ error: "not_found" });
    const b = req.body || {};
    const at = new Date(b.at);
    let listing = null;
    if (b.unitCode) {
      listing = await Store.findByCode(pool, broker.agency_id, String(b.unitCode));
      if (!listing) return res.status(422).json({ error: "unit_not_found" });
    }
    const lang = b.lang === "en" ? "en" : "ar";
    const clientLang = lead.lang || lang;
    const version = b.version === undefined || b.version === null || b.version === "" ? null : Number(b.version);
    const r = await Viewings.schedule(pool, broker, lead.id, { at, listing, place: b.place, version, lang: clientLang });
    if (r.conflict) return res.status(409).json({ error: "conflict", lead: leadView((await Leads.getLead(pool, broker, lead.id)) || lead) });
    if (r.error) return res.status(ERRORS[r.error] || 422).json({ error: r.error });
    const message = Viewings.clientMessage({ lead, actor: broker, listing, at, place: r.viewing.place, url: r.url, lang: clientLang });
    return res.status(201).json({ lead: leadView(r.lead || lead), viewing: { id: r.viewing.id, startsAt: iso(r.viewing.starts_at), place: r.viewing.place, status: r.viewing.status }, url: r.url, message, wa: r.wa || null });
  });

  // The broker's viewings between two dates (default: today and the next 60 days), for the calendar.
  api.get("/viewings", async (req, res) => {
    const { broker } = req.session;
    const tomorrow = req.query.tomorrow === "1";
    const now = new Date();
    const from = tomorrow ? Stages.cairoDayAt(now, 1, 0) : new Date(req.query.from || now.getTime() - 12 * 3600 * 1000);
    const to = tomorrow ? Stages.cairoDayAt(now, 2, 0) : new Date(req.query.to || now.getTime() + 60 * 86400 * 1000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return res.status(400).json({ error: "bad_dates" });
    const rows = await Viewings.listForBroker(pool, broker, { from, to });
    return res.json({
      items: rows.map((r) => ({ id: r.id, startsAt: iso(r.starts_at), place: r.place, status: r.status, proposedAt: iso(r.client_proposed_at), clientNote: r.client_note, leadRef: Card.refLabel(r.ref), leadName: r.name, unitCode: r.code }))
    });
  });

  // The client links this broker has shared, newest first, with how many times each was opened.
  api.get("/links", async (req, res) => {
    const { broker } = req.session;
    const offset = Math.max(0, Math.min(parseInt(req.query.offset, 10) || 0, 5000));
    const { rows } = await pool.query(
      `SELECT s.created_at, s.channel, s.open_count, s.last_opened_at, s.recipient_phone, s.note, l.code, l.compound, ld.ref, ld.name
         FROM share_links s JOIN listings l ON l.id = s.listing_id
         LEFT JOIN leads ld ON ld.id = s.lead_id
        WHERE ${Vis.units("l")} AND s.agency_id = $1 AND s.broker_id = $2 AND s.revoked_at IS NULL
        ORDER BY s.created_at DESC LIMIT ${PAGE + 1} OFFSET ${offset}`,
      [broker.agency_id, broker.id]
    );
    return res.json({
      offset,
      hasMore: rows.length > PAGE,
      items: rows.slice(0, PAGE).map((r) => ({ createdAt: iso(r.created_at), unitCode: r.code, compound: r.compound, opens: r.open_count, lastOpenedAt: iso(r.last_opened_at), recipientPhone: r.recipient_phone, leadRef: r.ref ? Card.refLabel(r.ref) : null, leadName: r.name || null, note: r.note }))
    });
  });
}

module.exports = { register };
