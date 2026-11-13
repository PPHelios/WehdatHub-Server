// api/leads.js — The broker's leads for the app: list, one lead, add, and the quick actions (called, stage, follow-up, note).
// All reads and writes go through services/leads.js, so lib/visibility and the permission checks (canViewLead / canEditLead)
// apply exactly as on the website. Writes carry the version the app last saw (409 + the latest lead on a change made meanwhile).
"use strict";

const Leads = require("../services/leads");
const Card = require("../domain/leadCard");
const Stages = require("../domain/leadStages");
const RateLimit = require("../lib/rateLimit");
const ReadCaps = require("../lib/readCaps");
const AI = require("../lib/ai");
const Phone = require("../domain/phone");
const Intake = require("../domain/leadIntake");
const LeadIntake = require("../lib/leadIntake");
const { logOperation } = require("../lib/db");
const Authz = require("../lib/authz");
const LeadMerge = require("../services/leadMerge");
const LeadRequests = require("../services/leadRequests");
const FollowUpDrafts = require("../services/followUpDrafts");
const Privacy = require("../services/privacy");
const Store = require("../lib/listingStore");

const PAGE = 20;
const TABS = ["all", ...Stages.STAGES, "due_today", "overdue", "no_next_step"];

function leadView(l) {
  return {
    ref: Card.refLabel(l.ref),
    name: l.name || null,
    phones: l.phones || [],
    kind: l.kind,
    stage: l.stage,
    lostReason: l.lost_reason || null,
    source: l.source || null,
    notes: l.notes || null,
    nextFollowUpAt: l.next_follow_up_at ? new Date(l.next_follow_up_at).toISOString() : null,
    followUpKind: l.follow_up_status === "open" ? l.follow_up_kind : null,
    followUpNote: l.follow_up_status === "open" ? l.follow_up_note || null : null,
    lastContactAt: l.last_contact_at ? new Date(l.last_contact_at).toISOString() : null,
    assignee: l.assignee_name || null,
    assigneeId: l.assigned_broker_id || null,
    version: l.version
  };
}

const ERRORS = {
  phone_required: 422, phone_invalid: 422, too_many_phones: 422, lawful_basis: 422, kind: 422, assignee: 422, assignee_away: 422,
  lost_reason_required: 422, follow_up_time: 422, past: 422, note_empty: 422, note_too_long: 422, unknown_stage: 422, unit_not_found: 422,
  forbidden: 403, not_found: 404
};

function register(api, { pool }) {
  const writeGate = async (req, res) => {
    const gate = await RateLimit.hit(pool, `crm_write:broker:${req.session.broker.id}`, RateLimit.LIMITS.crmWriteBroker);
    if (gate.allowed) return true;
    res.status(429).set("Retry-After", String(gate.retryAfterSec)).json({ error: "rate_limited" });
    return false;
  };
  const load = async (req, res) => {
    const lead = await Leads.getLead(pool, req.session.broker, req.params.ref);
    if (!lead) res.status(404).json({ error: "not_found" });
    return lead;
  };
  /** A service result → the answer: the changed lead, a 409 with the latest lead, or the error. */
  const answer = async (req, res, lead, r) => {
    if (r.conflict) return res.status(409).json({ error: "conflict", lead: leadView((await Leads.getLead(pool, req.session.broker, lead.id)) || lead) });
    if (r.error) return res.status(ERRORS[r.error] || 422).json({ error: r.error });
    return res.json({ lead: leadView(r.lead || lead), undoEventId: r.eventId || null });
  };
  const tabFilter = (tab) => ({ stage: Stages.STAGES.includes(tab) ? tab : null, dueToday: tab === "due_today", overdue: tab === "overdue", noNextStep: tab === "no_next_step" });
  const versionOf = (b) => (b.version === undefined || b.version === null || b.version === "" ? null : Number(b.version));

  api.get("/leads", async (req, res) => {
    const { broker } = req.session;
    const tab = TABS.includes(req.query.tab) ? req.query.tab : "all";
    const offset = Math.max(0, Math.min(parseInt(req.query.offset, 10) || 0, 10000));
    if (offset > ReadCaps.maxOffset(broker, 10000)) return res.status(403).json({ error: "too_deep" });
    const { rows, more, total } = await Leads.listLeads(pool, broker, { ...tabFilter(tab), q: String(req.query.q || "").slice(0, 80), limit: PAGE, offset, brokerId: String(req.query.broker || "") });
    const cap = await ReadCaps.takeListRows(pool, broker, "leads", rows.length);
    if (!cap.allowed) return res.set("Retry-After", String(cap.retryAfterSec)).status(429).json({ error: "daily_cap" });
    res.json({ items: rows.map(leadView), more, total, offset, limit: PAGE });
  });

  // The number on every tab, from the start (same filters as the list, with the search text).
  api.get("/leads/counts", async (req, res) => {
    const { broker } = req.session;
    const q = String(req.query.q || "").slice(0, 80);
    const entries = await Promise.all(TABS.map(async (t) => [t, (await Leads.listLeads(pool, broker, { ...tabFilter(t), q, countOnly: true })).total]));
    res.json({ counts: Object.fromEntries(entries) });
  });

  api.get("/leads/:ref", async (req, res) => {
    const t = await Leads.timeline(pool, req.session.broker, req.params.ref, { limit: 20 });
    if (!t) return res.status(404).json({ error: "not_found" });
    res.json({
      lead: leadView(t.lead),
      timeline: t.rows.filter((e) => !e.undone_at).map((e) => ({ id: String(e.id), kind: e.kind, at: new Date(e.created_at).toISOString(), by: e.broker_name || null, text: e.data?.text || e.data?.note || null, stage: e.data?.stage || null }))
    });
  });

  // Fill a lead form from a pasted or shared message (nothing is saved): name, phones, kind, source and a note.
  api.post("/leads/extract", async (req, res) => {
    const { broker } = req.session;
    const lang = broker.preferred_lang === "en" ? "en" : "ar";
    const text = String(req.body?.message || "").trim().slice(0, 4000);
    if (!text) return res.status(400).json({ error: "nothing_to_read" });
    const gate = await RateLimit.hit(pool, `lead_extract:broker:${broker.id}`, RateLimit.LIMITS.extractBroker);
    if (!gate.allowed) return res.status(429).set("Retry-After", String(gate.retryAfterSec)).json({ error: "rate_limited" });
    let ex = { phones: [], name: null, kind: null, source: null, note: null };
    try {
      ex = await LeadIntake.extractLead(AI, { text, voice: null, lang, ctx: { pool, broker } });
    } catch (err) {
      console.warn("App lead extraction failed:", err.message);
    }
    const found = (ex.phones || []).map((p) => Phone.toE164(p)).filter(Boolean);
    const phones = (found.length ? found : Intake.findPhones(text)).slice(0, 3).map((p) => Phone.displayPhone(p).replace(/\s/g, ""));
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "app_lead_extract", metadata: { text: true } });
    res.json({ name: ex.name || "", phones, kind: ex.kind || "buyer", source: ex.source || "", note: ex.note || "" });
  });

  api.post("/leads", async (req, res) => {
    if (!(await writeGate(req, res))) return;
    const b = req.body || {};
    const r = await Leads.captureLead(pool, req.session.broker, {
      phones: [b.phone1, b.phone2, b.phone3].map((p) => String(p || "").trim()).filter(Boolean),
      name: b.name,
      kind: b.kind || "buyer",
      source: String(b.source || "").trim() || "App",
      lawfulBasis: b.lawfulBasis,
      notes: b.notes
    });
    if (r.outcome === "created") return res.status(201).json({ outcome: "created", lead: leadView(r.lead) });
    if (r.outcome === "merged") return res.json({ outcome: "merged", lead: leadView(r.lead) });
    if (r.outcome === "colleague") return res.status(409).json({ error: "colleague" });
    if (r.outcome === "erased_before") return res.status(409).json({ error: "erased_before" });
    return res.status(ERRORS[r.error] || 422).json({ error: r.error || "invalid" });
  });

  // Reassign: managers anywhere, a team lead inside their team (or back to the managers with brokerId null).
  api.post("/leads/:ref/assign", async (req, res) => {
    if (!(await writeGate(req, res))) return;
    const lead = await load(req, res);
    if (!lead) return;
    const b = req.body || {};
    return answer(req, res, lead, await Leads.assignLead(pool, req.session.broker, lead.id, b.brokerId || null, { version: versionOf(b) }));
  });

  // Managers merge a duplicate record into this one; they erase a client (typing the last 4 digits). Same services as the website.
  api.post("/leads/:ref/merge", async (req, res) => {
    if (!(await writeGate(req, res))) return;
    const lead = await load(req, res);
    if (!lead) return;
    const b = req.body || {};
    const out = await LeadMerge.merge(pool, req.session.broker, lead.id, String(b.other || "").trim(), { confirm: String(b.confirm || "").trim() });
    if (out.error) return res.status(out.error === "forbidden" ? 403 : out.error === "not_found" ? 404 : 422).json({ error: out.error });
    return res.json({ lead: leadView(out.lead) });
  });
  api.post("/leads/:ref/erase", async (req, res) => {
    if (!Authz.isManager(req.session.broker)) return res.status(403).json({ error: "forbidden" });
    if (!(await writeGate(req, res))) return;
    const r = await Privacy.eraseLead(pool, req.session.broker, req.params.ref, { confirm: String((req.body || {}).confirm || "") });
    if (r.error) return res.status(r.error === "not_found" ? 404 : r.error === "confirm" ? 422 : 403).json({ error: r.error });
    return res.json({ ok: true });
  });
  // The next message to the client, drafted from the lead's record; and "send to client": a share link with the unit, WhatsApp-ready.
  api.post("/leads/:ref/draft", async (req, res) => {
    if (!(await writeGate(req, res))) return;
    const lead = await load(req, res);
    if (!lead) return;
    const lang = lead.lang === "en" || lead.lang === "ar" ? lead.lang : req.body?.lang === "en" ? "en" : "ar";
    const out = await FollowUpDrafts.draft(pool, req.session.broker, lead.id, { lang });
    if (out.error) return res.status(out.error === "ai" ? 503 : out.error === "not_found" ? 404 : 429).json({ error: out.error });
    return res.json({ text: out.text, wa: out.wa || null });
  });
  api.post("/leads/:ref/send", async (req, res) => {
    if (!(await writeGate(req, res))) return;
    const lead = await load(req, res);
    if (!lead) return;
    const b = req.session.broker;
    const unit = await Store.findByCode(pool, b.agency_id, String((req.body || {}).code || ""));
    const r = await LeadRequests.sendToClient(pool, b, lead.id, unit, { lang: req.body?.lang === "en" ? "en" : "ar" });
    if (r.ok) return res.json({ url: r.url });
    return res.status(r.error === "forbidden" ? 403 : 422).json({ error: r.error || "unit" });
  });

  // Ask manager: a broker asks managers (or the owner) for help on a lead; a manager marks it handled with an optional reply.
  api.post("/leads/:ref/request", async (req, res) => {
    if (!(await writeGate(req, res))) return;
    const lead = await load(req, res);
    if (!lead) return;
    const b = req.body || {};
    const r = await Leads.flagForManager(pool, req.session.broker, lead.id, b.text, { to: b.to === "owner" ? "owner" : "manager", version: versionOf(b) });
    if (r.error === "already_flagged") return res.status(409).json({ error: "already_flagged" });
    return answer(req, res, lead, r);
  });
  api.post("/leads/:ref/request/handle", async (req, res) => {
    if (!(await writeGate(req, res))) return;
    const lead = await load(req, res);
    if (!lead) return;
    const b = req.body || {};
    const r = await Leads.handleFlag(pool, req.session.broker, lead.id, b.reply, { version: versionOf(b) });
    if (r.unchanged) return res.json({ lead: leadView(lead), closed: 0 });
    if (r.ok) return res.json({ lead: leadView(r.lead), closed: r.closed });
    return answer(req, res, lead, r);
  });
  api.get("/leads/:ref/requests", async (req, res) => {
    const lead = await load(req, res);
    if (!lead) return;
    const items = await Leads.openRequestsOn(pool, req.session.broker, lead.id);
    return res.json({ items: items.map((x) => ({ id: x.id, note: x.note, to: x.to_role, by: x.broker_name || null, mine: x.mine, at: new Date(x.created_at).toISOString() })) });
  });
  // The open requests waiting on this manager or owner (403 for a plain broker).
  api.get("/requests", async (req, res) => {
    const rows = await Leads.openFlags(pool, req.session.broker);
    if (!rows) return res.status(403).json({ error: "forbidden" });
    return res.json({ items: rows.map((r) => ({ id: r.request_id, ref: Card.refLabel(r.ref), name: r.name || null, note: r.request_note, to: r.to_role, by: r.flagged_by_name || null, at: new Date(r.requested_at).toISOString() })) });
  });

  api.post("/leads/:ref/contacted", async (req, res) => {
    if (!(await writeGate(req, res))) return;
    const lead = await load(req, res);
    if (!lead) return;
    return answer(req, res, lead, await Leads.markContacted(pool, req.session.broker, lead.id, { version: versionOf(req.body || {}) }));
  });

  api.post("/leads/:ref/stage", async (req, res) => {
    if (!(await writeGate(req, res))) return;
    const lead = await load(req, res);
    if (!lead) return;
    const b = req.body || {};
    return answer(req, res, lead, await Leads.setStage(pool, req.session.broker, lead.id, { stage: b.stage, lostReason: b.lostReason, version: versionOf(b) }));
  });

  api.post("/leads/:ref/follow-up", async (req, res) => {
    if (!(await writeGate(req, res))) return;
    const lead = await load(req, res);
    if (!lead) return;
    const b = req.body || {};
    return answer(req, res, lead, await Leads.setFollowUp(pool, req.session.broker, lead.id, { at: b.at, kind: b.kind === "viewing" ? "viewing" : "call", note: b.note, version: versionOf(b) }));
  });

  api.post("/leads/:ref/note", async (req, res) => {
    if (!(await writeGate(req, res))) return;
    const lead = await load(req, res);
    if (!lead) return;
    const b = req.body || {};
    return answer(req, res, lead, await Leads.addNote(pool, req.session.broker, lead.id, b.text, { version: versionOf(b) }));
  });
}

module.exports = { register, leadView };
