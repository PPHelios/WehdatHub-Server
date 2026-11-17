// services/followUpDrafts.js — Follow-up message drafts (Release B, N2): after a call or viewing, the next WhatsApp
// message to the client, drafted from the lead's own record (domain/followUpDraft.js) from a template (no AI call). Only someone who may see the lead can draft. The broker reviews and sends it themselves (wa.me to the client's number).
"use strict";

const D = require("../domain/followUpDraft");
const ParserLog = require("./parserLog");
const Card = require("../domain/leadCard");
const Phone = require("../domain/phone");
const Leads = require("./leads");
const LeadRequests = require("./leadRequests");
const Viewings = require("./viewings");

/** → { text, lead, wa } | { error: 'not_found' } */
async function draft(pool, broker, leadKey, { lang = "ar" } = {}) {
  const lead = await Leads.getLead(pool, broker, leadKey);
  if (!lead) return { error: "not_found" };
  const [{ rows: events }, requests, viewing, { rows: me }] = await Promise.all([
    pool.query("SELECT kind, data, created_at FROM lead_events WHERE lead_id = $1 AND agency_id = $2 AND undone_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 12", [lead.id, broker.agency_id]),
    LeadRequests.listRequests(pool, broker, lead),
    Viewings.latestFor(pool, broker.agency_id, lead.id),
    pool.query("SELECT b.name, a.name AS agency_name FROM brokers b JOIN agencies a ON a.id = b.agency_id WHERE b.id = $1", [broker.id])
  ]);
  // A template filled from the lead's own record: no AI call, nothing to run out (Parser consolidation, Phase 4).
  // The broker edits it before sending.
  const out = { text: D.template({ lead, events, requests, viewing, broker: { name: me[0]?.name || broker.name }, agencyName: me[0]?.agency_name, lang, requestLine: (f) => Card.requestSummary(f, lang) }) };
  ParserLog.logParserRead(pool, { agency_id: broker.agency_id, broker_id: broker.id, parser: "follow_up_draft", kind: "template", result: { read: ["name", requests.length ? "request" : null, viewing ? "viewing" : null, events.length ? "events" : null].filter(Boolean), missing: [lead.name ? null : "name", requests.length ? null : "request"].filter(Boolean) } });
  if (out.error) return out;
  return { text: out.text, lead, wa: Phone.waMeUrl(lead.phone_e164, out.text) };
}

module.exports = { draft };
