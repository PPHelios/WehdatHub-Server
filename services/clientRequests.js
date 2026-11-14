// services/clientRequests.js — The client requests page (website and app): every request (a saved search with alerts,
// tied to a lead or not) in Pending and Fulfilled tabs, add one (a text description, optionally linked to a lead by
// code or phone), mark one fulfilled, delete one. Brokers see their own; managers see the whole agency.
"use strict";

const Leads = require("./leads");
const LeadRequests = require("./leadRequests");
const Saved = require("./savedSearches");
const Dash = require("./dashboards");
const Card = require("../domain/leadCard");
const Q = require("../domain/searchQuery");
const SearchLink = require("../domain/searchLink");

const PAGE = 20;
const UUID = /^[0-9a-f-]{36}$/i;
const IS_REQUEST = "(s.lead_id IS NOT NULL OR s.alerts_enabled OR s.fulfilled_at IS NOT NULL)";

function scope(actor) {
  return Dash.isManager(actor) ? { sql: "", params: [] } : { sql: " AND s.broker_id = $2", params: [actor.id] };
}

/** → { items: [{ id, filters, token, lead: {ref,name,phone_e164}|null, broker_name, alerts, matches, created_at, fulfilled_at }], page, pages, total, pending, fulfilled } */
async function list(pool, actor, { tab = "pending", page = 1 } = {}) {
  const sc = scope(actor);
  const base = [actor.agency_id, ...sc.params];
  const counts = await pool.query(
    `SELECT count(*) FILTER (WHERE s.fulfilled_at IS NULL)::int AS pending, count(*) FILTER (WHERE s.fulfilled_at IS NOT NULL)::int AS fulfilled
       FROM saved_searches s WHERE s.agency_id = $1${sc.sql} AND ${IS_REQUEST}`,
    base
  );
  const fulfilledTab = tab === "fulfilled";
  const total = counts.rows[0][fulfilledTab ? "fulfilled" : "pending"];
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const p = Math.min(Math.max(1, Number(page) || 1), pages);
  const { rows } = await pool.query(
    `SELECT s.id, s.filters, s.alerts_enabled, s.created_at, s.fulfilled_at, s.lead_id, l.ref AS lead_ref, l.name AS lead_name, l.phone_e164 AS lead_phone, b.name AS broker_name
       FROM saved_searches s
       LEFT JOIN leads l ON l.id = s.lead_id AND l.agency_id = s.agency_id
       LEFT JOIN brokers b ON b.id = s.broker_id AND b.agency_id = s.agency_id
      WHERE s.agency_id = $1${sc.sql} AND ${IS_REQUEST} AND s.fulfilled_at IS ${fulfilledTab ? "NOT NULL" : "NULL"}
      ORDER BY COALESCE(s.fulfilled_at, s.created_at) DESC, s.id
      LIMIT ${PAGE} OFFSET ${(p - 1) * PAGE}`,
    base
  );
  const items = [];
  for (const r of rows) {
    const filters = SearchLink.sanitizeFilters(r.filters);
    const m = fulfilledTab ? { total: 0 } : await LeadRequests.currentMatches(pool, actor.agency_id, filters, { limit: 1 });
    items.push({
      id: r.id,
      filters,
      token: SearchLink.encodeFilters(filters),
      lead: r.lead_id ? { ref: Card.refLabel(r.lead_ref), name: r.lead_name || "", phone_e164: r.lead_phone } : null,
      broker_name: r.broker_name || "",
      alerts: r.alerts_enabled,
      matches: m.total,
      created_at: r.created_at,
      fulfilled_at: r.fulfilled_at
    });
  }
  return { items, page: p, pages, total, pending: counts.rows[0].pending, fulfilled: counts.rows[0].fulfilled };
}

/** The request row if this person may handle it. */
async function reachable(pool, actor, id) {
  if (!UUID.test(String(id))) return null;
  const sc = scope(actor);
  const { rows } = await pool.query(`SELECT s.id FROM saved_searches s WHERE s.id = $${sc.params.length + 2} AND s.agency_id = $1${sc.sql} AND ${IS_REQUEST}`, [actor.agency_id, ...sc.params, id]);
  return rows[0] || null;
}

async function remove(pool, actor, id) {
  const r = await reachable(pool, actor, id);
  if (!r) return { error: "not_found" };
  await pool.query("DELETE FROM saved_searches WHERE id = $1 AND agency_id = $2", [r.id, actor.agency_id]);
  return { ok: true };
}

async function fulfil(pool, actor, id) {
  const r = await reachable(pool, actor, id);
  if (!r) return { error: "not_found" };
  await pool.query("UPDATE saved_searches SET fulfilled_at = COALESCE(fulfilled_at, now()), alerts_enabled = false, updated_at = now() WHERE id = $1 AND agency_id = $2", [r.id, actor.agency_id]);
  return { ok: true };
}

/**
 * Adds a request from a text description ({ q }) or filters ({ filters }), optionally linked to a lead by code (L-0042) or phone.
 * @returns {{ ok, id, lead } | { error: "invalid"|"lead_not_found"|"forbidden"|"too_many_requests"|"too_many_requests_broker" }}
 */
async function add(pool, actor, { q, filters, lead: leadText } = {}) {
  const f = SearchLink.sanitizeFilters(filters || (q ? Q.fallbackParse(String(q).slice(0, 500)).filters : {}));
  if (!f || !Q.hasAnyFilter({ filters: f }) || f.code) return { error: "invalid" };
  const key = String(leadText || "").trim();
  if (!key) {
    const name = Card.requestSummary(f, "ar").replace(/\s+/g, " ").trim().slice(0, 80) || "طلب";
    const out = await Saved.save(pool, actor, { token: SearchLink.encodeFilters(f), name, alerts: true });
    if (out.error === "limit_alerts" || out.error === "limit") return { error: "too_many_requests_broker" };
    if (out.error) return { error: "invalid" };
    return { ok: true, id: out.id, lead: null };
  }
  let lead = Card.parseRef(key) ? await Leads.getLead(pool, actor, key) : null;
  if (!lead) lead = (await Leads.findByPhone(pool, actor, key)).lead;
  if (!lead) return { error: "lead_not_found" };
  const r = await LeadRequests.saveRequest(pool, actor, lead.id, f);
  if (r.error) return { error: r.error === "not_found" ? "lead_not_found" : r.error === "request_empty" ? "invalid" : r.error };
  return { ok: true, id: r.request.id, lead: { ref: Card.refLabel(lead.ref), name: lead.name || "" } };
}

module.exports = { PAGE, list, add, remove, fulfil };
