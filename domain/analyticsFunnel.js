// domain/analyticsFunnel.js — The monthly lead funnel (pure): one row per agency (its own data) and one market row of medians
// across agencies. The market row exists only when enough agencies and leads stand behind it (domain/analyticsPrivacy.js).
// Input holds no names, phones or notes: a lead is { agency_id, contacted, viewed, lost, source, lost_reason, response_min }.
"use strict";

const Privacy = require("./analyticsPrivacy");
const Bands = require("./analyticsBands");

const pct = (part, whole) => (whole > 0 ? Bands.round((100 * part) / whole, 1) : null);

function bump(obj, key) {
  obj[key] = (obj[key] || 0) + 1;
}

/**
 * @param {Array} leads            leads created in the month
 * @param {Object} dealsByAgency   { agency_id: deals closed in the month }
 * @param {string} month           YYYY-MM-01
 * @returns {Array} one row per agency with at least one lead
 */
function agencyRows(leads, dealsByAgency, month) {
  const by = new Map();
  for (const l of leads) {
    let a = by.get(l.agency_id);
    if (!a) {
      a = { agency_id: l.agency_id, leads: 0, contacted: 0, viewings: 0, lost: 0, resp: [], by_source: {}, lost_reasons: {} };
      by.set(l.agency_id, a);
    }
    a.leads += 1;
    if (l.contacted) a.contacted += 1;
    if (l.viewed) a.viewings += 1;
    if (l.lost) {
      a.lost += 1;
      bump(a.lost_reasons, Bands.lostKey(l.lost_reason));
    }
    bump(a.by_source, Bands.sourceKey(l.source));
    if (Number.isFinite(l.response_min) && l.response_min >= 0) a.resp.push(l.response_min);
  }
  return [...by.values()].map((a) => {
    const deals = Number((dealsByAgency || {})[a.agency_id]) || 0;
    return {
      month, agency_id: a.agency_id, leads: a.leads, contacted: a.contacted, viewings: a.viewings, deals, lost: a.lost,
      median_first_response_minutes: Bands.round(Bands.median(a.resp), 1),
      by_source: a.by_source, lost_reasons: a.lost_reasons,
      rates: { contacted_pct: pct(a.contacted, a.leads), viewing_pct: pct(a.viewings, a.leads), deals_pct: pct(deals, a.leads), lost_pct: pct(a.lost, a.leads) },
      agencies_n: null
    };
  });
}

/** The market row (agency_id null) from the agency rows, or null when it is too small to be written. */
function marketRow(rows, month) {
  const eligible = rows.filter((r) => r.leads >= Privacy.MIN_LEADS_PER_AGENCY);
  const cell = { agencies_n: eligible.length, rows_n: eligible.reduce((s, r) => s + r.leads, 0) };
  if (!Privacy.passes(cell)) return null;
  const med = (f) => Bands.round(Bands.median(eligible.map(f).filter((v) => v !== null && v !== undefined)), 1);
  const sum = (key) => {
    const o = {};
    for (const r of eligible) for (const [k, n] of Object.entries(r[key])) o[k] = (o[k] || 0) + n;
    return o;
  };
  return {
    month, agency_id: null,
    leads: Math.round(med((r) => r.leads)), contacted: Math.round(med((r) => r.contacted)), viewings: Math.round(med((r) => r.viewings)),
    deals: Math.round(med((r) => r.deals)), lost: Math.round(med((r) => r.lost)),
    median_first_response_minutes: med((r) => r.median_first_response_minutes),
    by_source: sum("by_source"), lost_reasons: sum("lost_reasons"),
    rates: { contacted_pct: med((r) => r.rates.contacted_pct), viewing_pct: med((r) => r.rates.viewing_pct), deals_pct: med((r) => r.rates.deals_pct), lost_pct: med((r) => r.rates.lost_pct) },
    agencies_n: cell.agencies_n
  };
}

module.exports = { agencyRows, marketRow };
