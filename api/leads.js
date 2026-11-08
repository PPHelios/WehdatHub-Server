// api/leads.js — The broker's leads for the app: list, one lead, add, and the quick actions (called, stage, follow-up, note).
// All reads and writes go through services/leads.js, so lib/visibility and the permission checks (canViewLead / canEditLead)
// apply exactly as on the website. Writes carry the version the app last saw (409 + the latest lead on a change made meanwhile).
"use strict";

const Leads = require("../services/leads");
const Card = require("../domain/leadCard");
const Stages = require("../domain/leadStages");
const RateLimit = require("../lib/rateLimit");

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
  const versionOf = (b) => (b.version === undefined || b.version === null || b.version === "" ? null : Number(b.version));

  api.get("/leads", async (req, res) => {
    const { broker } = req.session;
    const tab = TABS.includes(req.query.tab) ? req.query.tab : "all";
    const offset = Math.max(0, Math.min(parseInt(req.query.offset, 10) || 0, 10000));
    const { rows, more } = await Leads.listLeads(pool, broker, {
      q: String(req.query.q || "").slice(0, 80),
      stage: Stages.STAGES.includes(tab) ? tab : null,
      dueToday: tab === "due_today",
      overdue: tab === "overdue",
      noNextStep: tab === "no_next_step",
      limit: PAGE,
      offset
    });
    res.json({ items: rows.map(leadView), more, offset, limit: PAGE });
  });

  api.get("/leads/:ref", async (req, res) => {
    const t = await Leads.timeline(pool, req.session.broker, req.params.ref, { limit: 20 });
    if (!t) return res.status(404).json({ error: "not_found" });
    res.json({
      lead: leadView(t.lead),
      timeline: t.rows.filter((e) => !e.undone_at).map((e) => ({ id: String(e.id), kind: e.kind, at: new Date(e.created_at).toISOString(), by: e.broker_name || null, text: e.data?.text || e.data?.note || null, stage: e.data?.stage || null }))
    });
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
