// services/leads.js — The CRM's leads: capture with the Q2 duplicate rules, assignment, stage, notes,
// contact, follow-ups, a 10-minute undo, role-scoped lists and lookups, and releasing a leaving broker's leads (P6).
// Every query is scoped by agency; who sees what comes from lib/authz.js (Q1). Lead names and phones never
// go to operation_logs or log lines (PDPL): only the outcome and the L- reference.
"use strict";

const crypto = require("crypto");
const Phone = require("../domain/phone");
const Stages = require("../domain/leadStages");
const Card = require("../domain/leadCard");
const Authz = require("../lib/authz");
const Notifications = require("../lib/notifications");
const LeadRules = require("./leadRules");
const Rules = require("../domain/leadRules");
const { withTransaction, logOperation } = require("../lib/db");
const { getConfig } = require("../config");
const Vis = require("../lib/visibility");

const MAX_PHONES = 3;
const UNDO_MS = 10 * 60 * 1000;
const NOTE_MAX = 1000;
const PAGE = 20;
const DAY_MS = 24 * 3600 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BROKER_COLS = "id, agency_id, name, role, is_active, preferred_lang, phone_number, phone_normalized, notify_prefs, away_until, team_lead_id";
const LEAD_COLS = "l.*, a.name AS assignee_name, a.team_lead_id AS assignee_team_lead_id";
const FROM_LEADS = "FROM leads l LEFT JOIN brokers a ON a.id = l.assigned_broker_id AND a.agency_id = l.agency_id"; // vis:exempt: every use adds Vis.leads("l") to its WHERE

// The fields each reversible event changes; undo puts them back.
const FOLLOW_UP_FIELDS = ["next_follow_up_at", "follow_up_kind", "follow_up_listing_id", "follow_up_note", "follow_up_status", "follow_up_reminded_at"];
const REVERSIBLE = {
  stage: ["stage", "lost_reason"],
  contacted: ["stage", "last_contact_at", "response_due_at"],
  follow_up_set: FOLLOW_UP_FIELDS,
  follow_up_done: FOLLOW_UP_FIELDS,
  note: [],
  flag: ["flagged_at", "flag_note", "flagged_by"],
  flag_handled: ["flagged_at", "flag_note", "flagged_by"],
  assigned: ["assigned_broker_id", "assigned_at", "response_due_at", "response_jumps"]
};

const en = (b) => b?.preferred_lang === "en";
const L = (b, ar, eng) => (en(b) ? eng : ar);
const leadUrl = (lead) => `/app/leads/${Card.refLabel(lead.ref)}`;

/** Keyed hash of a phone (lead_erasures): the phone itself is never kept after an erase. */
function phoneHash(e164) {
  const key = getConfig().leads.hashKey;
  if (!key) throw new Error("LEAD_HASH_KEY is not set");
  return crypto.createHmac("sha256", key).update(String(e164)).digest("hex");
}

/** True when a client with this number asked to be erased from the actor's agency (the save form warns). */
async function wasErased(pool, actor, e164) {
  const { rows } = await pool.query("SELECT 1 FROM lead_erasures WHERE agency_id = $1 AND phone_hash = $2", [actor.agency_id, phoneHash(e164)]);
  return rows.length > 0;
}

/** Raw numbers (any spelling) → distinct E.164 numbers, or an error code. */
function normalizePhones(raw) {
  const list = (Array.isArray(raw) ? raw : [raw]).map((p) => String(p ?? "").trim()).filter(Boolean);
  if (!list.length) return { error: "phone_required" };
  const out = [];
  for (const p of list) {
    const e164 = Phone.toE164(p);
    if (!e164) return { error: "phone_invalid" };
    if (!out.includes(e164)) out.push(e164);
  }
  if (out.length > MAX_PHONES) return { error: "too_many_phones" };
  return { phones: out };
}

const cleanText = (v, max) => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};

async function brokerById(db, agencyId, id) {
  const { rows } = await db.query(`SELECT ${BROKER_COLS} FROM brokers WHERE id = $1 AND agency_id = $2`, [id, agencyId]);
  return rows[0] || null;
}

/** A lead key: its uuid, its number (42) or its reference ("L-0042"). */
function keyClause(key) {
  if (UUID.test(String(key))) return { sql: "l.id = $2", value: String(key) };
  const ref = Number.isInteger(key) ? key : Card.parseRef(key) || (/^\d+$/.test(String(key)) ? Number(key) : null);
  return ref ? { sql: "l.ref = $2", value: ref } : null;
}

async function loadLead(db, agencyId, key, { forUpdate = false } = {}) {
  const k = keyClause(key);
  if (!k) return null;
  const { rows } = await db.query(
    forUpdate ? `SELECT l.*, (SELECT a.team_lead_id FROM brokers a WHERE a.id = l.assigned_broker_id AND a.agency_id = l.agency_id) AS assignee_team_lead_id FROM leads l WHERE ${Vis.leads("l")} AND l.agency_id = $1 AND ${k.sql} FOR UPDATE` : `SELECT ${LEAD_COLS} ${FROM_LEADS} WHERE ${Vis.leads("l")} AND l.agency_id = $1 AND ${k.sql}`,
    [agencyId, k.value]
  );
  return rows[0] || null;
}

async function addEvent(db, lead, brokerId, kind, data = {}, now = new Date()) {
  const { rows } = await db.query(
    "INSERT INTO lead_events (agency_id, lead_id, broker_id, kind, data, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [lead.agency_id, lead.id, brokerId, kind, JSON.stringify(data), now.toISOString()]
  );
  return rows[0].id;
}

/* ---------------------------------------------------------------------- */
/* Notifications (Q2)                                                      */
/* ---------------------------------------------------------------------- */

/** Every active manager except the one who acted (they know already). */
async function alertManagers(pool, actor, { dedupeKey, title, body, url, leadId, now }) {
  const out = [];
  for (const m of await Notifications.managersOf(pool, actor.agency_id)) {
    if (m.id === actor.id) continue;
    await Notifications.notifyBroker(pool, m, { kind: "manager_alert", dedupeKey, title: title(m), body: body(m), url, leadId, now });
    out.push({ broker_id: m.id, kind: "manager_alert" });
  }
  return out;
}

/** The assignee gets the lead card (that's the point of assigning); nobody else hears about it. */
async function sendCard(pool, actor, lead, assigneeId, now) {
  if (!assigneeId || assigneeId === actor.id) return [];
  const b = await brokerById(pool, lead.agency_id, assigneeId);
  if (!b) return [];
  await Notifications.notifyBroker(pool, b, {
    kind: "assignment",
    dedupeKey: `lead_assigned:${lead.id}:${b.id}:${lead.version}`,
    title: L(b, `🧑‍💼 عميل جديد ليك: ${Card.displayName(lead, "ar")} · ${Card.refLabel(lead.ref)}`, `🧑‍💼 New lead for you: ${Card.displayName(lead, "en")} · ${Card.refLabel(lead.ref)}`),
    body: Card.card(lead, { lang: en(b) ? "en" : "ar" }),
    url: leadUrl(lead),
    leadId: lead.id,
    now
  });
  return [{ broker_id: b.id, kind: "assignment" }];
}

/* ---------------------------------------------------------------------- */
/* Capture                                                                 */
/* ---------------------------------------------------------------------- */

/**
 * Adds a lead, or finds the one that already has any of its numbers (Q2).
 * @param {Object} input - { phones, name, kind, lang, source, lawfulBasis, consentNote, notes, assignTo, allowErased, stage, lostReason }
 *   stage: a new lead's starting stage (imports); a merge never changes the stage.
 * @param {Object} opts - { now, quiet }: quiet sends no notification and writes no per-lead log (an import reports once)
 * @returns {Promise<{ outcome: "created"|"merged"|"colleague"|"erased_before"|"invalid", lead?, claimed?, error?, notified: Array }>}
 *   claimed: a broker re-captured an unassigned lead, which is now theirs.
 *   colleague: the number is a colleague's lead; it is not returned, its broker is not messaged, the managers are.
 */
async function captureLead(pool, actor, input = {}, { now = new Date(), quiet = false } = {}) {
  const parsed = normalizePhones(input.phones ?? input.phone);
  if (parsed.error) return { outcome: "invalid", error: parsed.error, notified: [] };
  const kind = input.kind || "buyer";
  if (!Stages.KINDS.includes(kind)) return { outcome: "invalid", error: "kind", notified: [] };
  const basis = input.lawfulBasis || "client_request";
  if (!Stages.LAWFUL_BASES.includes(basis)) return { outcome: "invalid", error: "lawful_basis", notified: [] };
  const stage = input.stage || "new";
  const lostReason = stage === "lost" ? cleanText(input.lostReason, 200) || "—" : null;
  if (Stages.stageError(stage, lostReason)) return { outcome: "invalid", error: "stage", notified: [] };
  const manager = Authz.isManager(actor);
  let assignee = manager ? input.assignTo || null : actor.id;
  if (assignee && assignee !== actor.id) {
    const b = await brokerById(pool, actor.agency_id, assignee);
    if (!b || !b.is_active) return { outcome: "invalid", error: "assignee", notified: [] };
    if (Rules.awayNow(b, now)) return { outcome: "invalid", error: "assignee_away", notified: [] };
  }
  // R3: a lead someone else gives a broker must be contacted in time (when the agency's rule is on).
  const due = assignee && assignee !== actor.id && stage === "new" ? await LeadRules.deadlineFor(pool, actor.agency_id, now) : null;

  const hashes = parsed.phones.map(phoneHash);
  if (!input.allowErased) {
    const erased = await pool.query("SELECT 1 FROM lead_erasures WHERE agency_id = $1 AND phone_hash = ANY($2::text[]) LIMIT 1", [actor.agency_id, hashes]);
    if (erased.rows.length) return { outcome: "erased_before", notified: [] };
  }

  const res = await withTransaction(pool, async (client) => {
    // One capture at a time per agency, so two brokers adding the same number can't both create it.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('leads'), hashtext($1))", [actor.agency_id]);
    if (input.allowErased) await client.query("DELETE FROM lead_erasures WHERE agency_id = $1 AND phone_hash = ANY($2::text[])", [actor.agency_id, hashes]);
    const found = await client.query("SELECT * FROM leads WHERE " + Vis.leads("leads") + " AND agency_id = $1 AND phones && $2::text[] ORDER BY created_at LIMIT 1 FOR UPDATE", [
      actor.agency_id,
      parsed.phones
    ]);
    const existing = found.rows[0];

    if (existing) {
      const claim = !existing.assigned_broker_id && !manager;
      if (!claim && !Authz.canViewLead(actor, existing)) {
        await addEvent(client, existing, actor.id, "inquiry", { colleague: true }, now);
        return { outcome: "colleague", lead: existing };
      }
      // Numbers not on this lead (and not on another lead) are added, up to three.
      const fresh = parsed.phones.filter((p) => !existing.phones.includes(p));
      const taken = fresh.length
        ? (await client.query("SELECT unnest(phones) AS p FROM leads WHERE " + Vis.leads("leads") + " AND agency_id = $1 AND id <> $2 AND phones && $3::text[]", [actor.agency_id, existing.id, fresh])).rows.map((r) => r.p)
        : [];
      const added = fresh.filter((p) => !taken.includes(p)).slice(0, MAX_PHONES - existing.phones.length);
      const { rows } = await client.query(
        `UPDATE leads SET phones = phones || $3::text[], name = COALESCE(name, $4), assigned_broker_id = $5,
                source = COALESCE(source, $7), notes = COALESCE(notes, $8),
                assigned_at = CASE WHEN $9 THEN $6 ELSE assigned_at END,
                last_activity_at = $6, updated_at = $6, version = version + 1
          WHERE id = $1 AND agency_id = $2 RETURNING *`,
        [existing.id, actor.agency_id, added, cleanText(input.name, 120), claim ? actor.id : existing.assigned_broker_id, now.toISOString(), cleanText(input.source, 60), cleanText(input.notes, 4000), claim]
      );
      await addEvent(client, existing, actor.id, "inquiry", { source: cleanText(input.source, 60) }, now);
      if (added.length) await addEvent(client, existing, actor.id, "merged", { added: added.length }, now);
      if (claim) await addEvent(client, existing, actor.id, "assigned", { from: null, to: actor.id, to_name: actor.name || null }, now);
      return { outcome: "merged", lead: rows[0], claimed: claim };
    }

    const seq = await client.query("UPDATE agencies SET lead_ref_seq = lead_ref_seq + 1 WHERE id = $1 RETURNING lead_ref_seq", [actor.agency_id]);
    const { rows } = await client.query(
      `INSERT INTO leads (agency_id, ref, kind, assigned_broker_id, created_by_broker_id, name, phone_e164, phones, lang, source,
                          lawful_basis, consent_at, consent_note, notes, stage, lost_reason, last_activity_at, created_at, updated_at,
                          assigned_at, response_due_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $16, $17, $15, $15, $15, $18, $19) RETURNING *`,
      [
        actor.agency_id,
        seq.rows[0].lead_ref_seq,
        kind,
        assignee,
        actor.id,
        cleanText(input.name, 120),
        parsed.phones[0],
        parsed.phones,
        ["ar", "en"].includes(input.lang) ? input.lang : null,
        cleanText(input.source, 60),
        basis,
        basis === "consent" ? now.toISOString() : null,
        cleanText(input.consentNote, 300),
        cleanText(input.notes, 4000),
        now.toISOString(),
        stage,
        lostReason,
        assignee ? now.toISOString() : null,
        due ? due.toISOString() : null
      ]
    );
    if (assignee && assignee !== actor.id) await client.query("UPDATE brokers SET last_lead_at = $2 WHERE id = $1", [assignee, now.toISOString()]);
    await addEvent(client, rows[0], actor.id, "created", { source: cleanText(input.source, 60), assigned_to: assignee }, now);
    return { outcome: "created", lead: rows[0] };
  });

  const { lead } = res;
  const ref = Card.refLabel(lead.ref);
  let notified = [];
  if (quiet) return res.outcome === "colleague" ? { outcome: "colleague", lead: { id: lead.id, ref: lead.ref }, notified } : { outcome: res.outcome, lead, claimed: Boolean(res.claimed), notified };
  if (res.outcome === "created" || res.claimed) {
    const assigneeName = assignee && assignee !== actor.id ? (await brokerById(pool, actor.agency_id, assignee))?.name : null;
    notified = await alertManagers(pool, actor, {
      dedupeKey: `lead_new:${lead.id}`,
      title: (m) => L(m, `🆕 عميل جديد: ${Card.displayName(lead, "ar")} · ${ref}`, `🆕 New lead: ${Card.displayName(lead, "en")} · ${ref}`),
      body: (m) =>
        [L(m, `سجّله: ${actor.name || "—"}`, `Added by: ${actor.name || "—"}`), assigneeName ? L(m, `اتسلم لـ: ${assigneeName}`, `Assigned to: ${assigneeName}`) : lead.assigned_broker_id ? "" : L(m, "مش متسلم لحد لسه", "Not assigned yet")]
          .filter(Boolean)
          .join("\n"),
      url: leadUrl(lead),
      leadId: lead.id,
      now
    });
    if (res.outcome === "created") notified = notified.concat(await sendCard(pool, actor, lead, assignee, now));
  } else if (res.outcome === "colleague") {
    const owner = await brokerById(pool, actor.agency_id, lead.assigned_broker_id);
    notified = await alertManagers(pool, actor, {
      dedupeKey: `lead_dup:${lead.id}:${actor.id}:${now.toISOString().slice(0, 10)}`,
      title: (m) => L(m, `👥 عميل متسجل مع زميل: ${ref}`, `👥 Lead already with a colleague: ${ref}`),
      body: (m) =>
        L(
          m,
          `${actor.name || "—"} حاول يسجل ${Card.displayName(lead, "ar")}، وهو متسجل مع ${owner?.name || "—"}. تحوله ولا تسيبه؟`,
          `${actor.name || "—"} tried to add ${Card.displayName(lead, "en")}, who is already with ${owner?.name || "—"}. Reassign or leave it?`
        ),
      url: leadUrl(lead),
      leadId: lead.id,
      now
    });
  }
  await logOperation(pool, { agency_id: actor.agency_id, broker_id: actor.id, operation_type: "lead_capture", metadata: { outcome: res.outcome, ref } });
  return res.outcome === "colleague" ? { outcome: "colleague", notified } : { outcome: res.outcome, lead, claimed: Boolean(res.claimed), notified };
}

/* ---------------------------------------------------------------------- */
/* Changes (version-checked, logged, undoable)                             */
/* ---------------------------------------------------------------------- */

/**
 * Loads and locks the lead, checks rights and version, applies the fields and logs one event.
 * @param {Function} change - lead → { fields, data } | { error } | { unchanged: true }
 * @returns {Promise<{ ok, lead, eventId } | { error } | { conflict, lead } | { unchanged, lead }>}
 */
// Changes a team lead hears about (on the lead's assignee's team).

/** Tells the team lead of the lead's assignee about an update or a status change (not to the one who made it). */
async function tellTeamLead(pool, actor, lead, kind, eventId, now) {
  if (!lead.assigned_broker_id || Authz.isManager(actor)) return; // a manager's action is not sent to the team lead
  const { rows } = await pool.query(
    "SELECT t.id, t.agency_id, t.name, t.role, t.is_active, t.preferred_lang, t.notify_prefs FROM brokers b JOIN brokers t ON t.id = b.team_lead_id WHERE b.id = $1 AND t.is_active",
    [lead.assigned_broker_id]
  );
  const tl = rows[0];
  if (!tl || tl.id === actor.id) return;
  const what = { note: L(tl, "تحديث", "update"), stage: L(tl, "تغيير مرحلة", "stage change"), contacted: L(tl, "اتكلّم", "contacted"), follow_up_set: L(tl, "متابعة", "follow-up"), follow_up_done: L(tl, "متابعة خلصت", "follow-up done"), flag: L(tl, "طلب مساعدة", "request"), flag_handled: L(tl, "طلب اتعالج", "request done") }[kind] || kind;
  await Notifications.notifyBroker(pool, tl, {
    kind: "team_activity",
    dedupeKey: `team:${eventId}:${tl.id}`,
    title: L(tl, `🧑‍💼 ${actor.name}: ${what} · ${Card.displayName(lead, tl.preferred_lang)}`, `🧑‍💼 ${actor.name}: ${what} · ${Card.displayName(lead, tl.preferred_lang)}`),
    body: Card.refLabel(lead.ref),
    url: leadUrl(lead),
    leadId: lead.id,
    now
  });
}

async function mutate(pool, actor, key, { kind, version = null, manage = false, now = new Date() }, change) {
  const out = await mutateInTransaction(pool, actor, key, { kind, version, manage, now }, change);
  if (out.ok && !out.lead.is_private) await tellTeamLead(pool, actor, out.lead, kind, out.eventId, now);
  return out;
}

async function mutateInTransaction(pool, actor, key, { kind, version = null, manage = false, now = new Date() }, change) {
  return withTransaction(pool, async (client) => {
    const lead = await loadLead(client, actor.agency_id, key, { forUpdate: true });
    if (!lead) return { error: "not_found" };
    if (manage ? !Authz.canManageLeads(actor) : !Authz.canEditLead(actor, lead)) return { error: "forbidden" };
    if (version !== null && version !== undefined && Number(version) !== lead.version) return { conflict: true, lead };
    const c = change(lead);
    if (c.error || c.unchanged) return { ...c, lead };
    return { ok: true, ...(await applyChange(client, actor, lead, kind, c, now)) };
  });
}

/** Inside a transaction, on a locked lead: applies the fields and logs one event with what undo restores. */
async function applyChange(client, actor, lead, kind, c, now) {
  const fields = c.fields || {};
  const cols = Object.keys(fields);
  const { rows } = await client.query(
    `UPDATE leads SET ${cols.map((col, i) => `${col} = $${i + 3}, `).join("")}last_activity_at = $${cols.length + 3}, updated_at = $${cols.length + 3}, version = version + 1
      WHERE id = $1 AND agency_id = $2 RETURNING *`,
    [lead.id, actor.agency_id, ...cols.map((col) => fields[col]), now.toISOString()]
  );
  const prev = Object.fromEntries((REVERSIBLE[kind] || cols).map((col) => [col, lead[col] instanceof Date ? lead[col].toISOString() : (lead[col] ?? null)]));
  const eventId = await addEvent(client, lead, actor.id, kind, { ...c.data, prev, version: rows[0].version }, now);
  return { lead: rows[0], eventId };
}

/**
 * The voice CRM update (step 9), on Confirm: contacted, stage, follow-up and note as one transaction, one event each
 * (so each shows on the timeline and the set undoes together with undoMany).
 * @param {Object} u - { contacted, stage, lostReason, followUp: { at, kind, listingId } | null, note, via }
 * @returns {Promise<{ ok, lead, eventIds } | { unchanged, lead } | { error }>}
 */
async function applyUpdate(pool, actor, key, u, { now = new Date() } = {}) {
  if (u.stage) {
    const err = Stages.stageError(u.stage, u.stage === "lost" ? u.lostReason || "—" : null);
    if (err) return { error: err };
  }
  if (u.followUp) {
    if (!(u.followUp.at instanceof Date) || Number.isNaN(u.followUp.at.getTime())) return { error: "follow_up_time" };
    if (u.followUp.listingId) {
      const x = await pool.query("SELECT 1 FROM listings WHERE " + Vis.units("listings") + " AND id = $1 AND agency_id = $2", [u.followUp.listingId, actor.agency_id]);
      if (!x.rows.length) return { error: "unit_not_found" };
    }
  }
  const out = await withTransaction(pool, async (client) => {
    let lead = await loadLead(client, actor.agency_id, key, { forUpdate: true });
    if (!lead) return { error: "not_found" };
    if (!Authz.canEditLead(actor, lead)) return { error: "forbidden" };
    const eventIds = [];
    const kinds = [];
    const step = async (kind, c) => {
      const r = await applyChange(client, actor, lead, kind, c, now);
      lead = r.lead;
      eventIds.push(r.eventId);
      kinds.push({ kind, eventId: r.eventId });
    };
    const via = u.via || null;
    if (u.contacted) {
      const c = contactChange(lead, actor, now);
      await step("contacted", { fields: c.fields, data: { ...c.data, via } });
    }
    if (u.stage) {
      const reason = u.stage === "lost" ? cleanText(u.lostReason || "—", 200) : null;
      if (lead.stage !== u.stage || (lead.lost_reason || null) !== reason) await step("stage", { fields: { stage: u.stage, lost_reason: reason }, data: { from: lead.stage, to: u.stage, lost_reason: reason, via } });
    }
    if (u.followUp) {
      const f = u.followUp;
      await step("follow_up_set", {
        fields: { next_follow_up_at: f.at.toISOString(), follow_up_kind: f.kind, follow_up_listing_id: f.listingId || null, follow_up_note: null, follow_up_status: "open", follow_up_reminded_at: null },
        data: { at: f.at.toISOString(), kind: f.kind, listing_id: f.listingId || null, via }
      });
    }
    if (u.note) await step("note", { fields: {}, data: { text: cleanText(u.note, NOTE_MAX), via } });
    if (!eventIds.length) return { unchanged: true, lead };
    return { ok: true, lead, eventIds, kinds };
  });
  // The team lead hears each step after the commit (one notice per step, as with the single actions).
  if (out.ok && !out.lead.is_private) for (const k of out.kinds) await tellTeamLead(pool, actor, out.lead, k.kind, k.eventId, now);
  return out;
}

/** Inside the deal's transaction (services/deals.js): the lead is won, with a "deal" event (not undoable). */
async function recordDeal(client, actor, leadId, { dealId, ref, price, unitCode }, now = new Date()) {
  const lead = await loadLead(client, actor.agency_id, leadId, { forUpdate: true });
  if (!lead) return null;
  return applyChange(client, actor, lead, "deal", { fields: { stage: "won", lost_reason: null }, data: { deal_id: dealId, ref, price, unit_code: unitCode, from: lead.stage } }, now);
}

/** Undoes a set of events (newest first); stops at the first that can't be undone. */
async function undoMany(pool, actor, eventIds, { now = new Date() } = {}) {
  let last = null;
  for (const id of [...eventIds].sort((a, b) => Number(b) - Number(a))) {
    last = await undo(pool, actor, id, { now });
    if (!last.ok) return last;
  }
  return last || { error: "not_found" };
}

/** Managers only: assign to a broker of the agency, or back to the unassigned pool (null). */
async function assignLead(pool, actor, key, toBrokerId, { version = null, now = new Date() } = {}) {
  let target = null;
  if (toBrokerId) {
    target = await brokerById(pool, actor.agency_id, toBrokerId);
    if (!target || !target.is_active) return { error: "assignee" };
    if (Rules.awayNow(target, now)) return { error: "assignee_away" };
  }
  // Managers may reassign anything; a team lead only within their team, or back to the managers (no one).
  const found = await loadLead(pool, actor.agency_id, key);
  if (!found) return { error: "not_found" };
  if (!Authz.canReassignLead(actor, found, target ? target.team_lead_id : null, target ? target.id : null)) return { error: "forbidden" };
  const deadline = target && target.id !== actor.id ? await LeadRules.deadlineFor(pool, actor.agency_id, now) : null;
  const r = await mutate(pool, actor, key, { kind: "assigned", version, manage: false, now }, (lead) =>
    lead.assigned_broker_id === (target?.id || null)
      ? { unchanged: true }
      : {
          fields: {
            assigned_broker_id: target?.id || null,
            follow_up_reminded_at: null,
            assigned_at: target ? now.toISOString() : null,
            response_due_at: deadline && lead.stage === "new" && !lead.last_contact_at ? deadline.toISOString() : null,
            response_jumps: 0
          },
          data: { from: lead.assigned_broker_id, to: target?.id || null, to_name: target?.name || null }
        }
  );
  if (r.ok && target && target.id !== actor.id) await pool.query("UPDATE brokers SET last_lead_at = $2 WHERE id = $1", [target.id, now.toISOString()]);
  if (r.ok) r.notified = await sendCard(pool, actor, r.lead, target?.id, now);
  return r;
}

/** Q4: any stage to any other; lost needs a reason. */
async function setStage(pool, actor, key, { stage, lostReason = null, version = null, now = new Date() } = {}) {
  const err = Stages.stageError(stage, lostReason);
  if (err) return { error: err };
  return mutate(pool, actor, key, { kind: "stage", version, now }, (lead) => {
    const reason = stage === "lost" ? cleanText(lostReason, 200) : null;
    if (lead.stage === stage && (lead.lost_reason || null) === reason) return { unchanged: true };
    return { fields: { stage, lost_reason: reason }, data: { from: lead.stage, to: stage, lost_reason: reason } };
  });
}

/** An internal note on the timeline (never in a client copy). */
async function addNote(pool, actor, key, text, { version = null, now = new Date() } = {}) {
  const note = String(text ?? "").trim();
  if (!note) return { error: "note_empty" };
  if (note.length > NOTE_MAX) return { error: "note_too_long" };
  return mutate(pool, actor, key, { kind: "note", version, now }, () => ({ fields: {}, data: { text: note } }));
}

/** Who may receive a request: every manager, or the agency owner only. */
const REQUEST_ROLES = { manager: ["admin", "owner", "manager"], owner: ["owner"] };

/**
 * A broker asks managers (or the owner) for help on a lead. One open request per broker per lead. Returns { ok, lead,
 * requestId } | { error }. The request does not change the lead's stage.
 */
async function flagForManager(pool, actor, key, text, { to = "manager", version = null, now = new Date() } = {}) {
  const note = String(text ?? "").trim();
  if (!note) return { error: "flag_empty" };
  if (note.length > NOTE_MAX) return { error: "note_too_long" };
  if (!REQUEST_ROLES[to]) return { error: "request_recipient" };
  const found = await loadLead(pool, actor.agency_id, key);
  if (!found) return { error: "not_found" };
  if (!Authz.canEditLead(actor, found)) return { error: "forbidden" };
  const open = await pool.query("SELECT 1 FROM lead_requests WHERE lead_id = $1 AND broker_id = $2 AND handled_at IS NULL", [found.id, actor.id]);
  if (open.rows.length) return { error: "already_flagged" };
  const r = await mutate(pool, actor, key, { kind: "flag", version, now }, () => ({ fields: {}, data: { text: note, to } }));
  if (!r.ok) return r;
  const { rows } = await pool.query(
    "INSERT INTO lead_requests (agency_id, lead_id, broker_id, to_role, note, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [actor.agency_id, r.lead.id, actor.id, to, note, now.toISOString()]
  );
  r.requestId = rows[0].id;
  if (!r.lead.is_private) {
    for (const m of await Notifications.brokersWithRoles(pool, actor.agency_id, REQUEST_ROLES[to])) {
      if (m.id === actor.id) continue;
      await Notifications.notifyBroker(pool, m, {
        kind: "manager_alert",
        dedupeKey: `flag:${rows[0].id}:${m.id}`,
        title: L(m, `🙋 ${actor.name} محتاج ${to === "owner" ? "المالك" : "مدير"}: ${Card.displayName(r.lead, m.preferred_lang)}`, `🙋 ${actor.name} needs ${to === "owner" ? "the owner" : "a manager"}: ${Card.displayName(r.lead, m.preferred_lang)}`),
        body: `${Card.refLabel(r.lead.ref)} · ${note.slice(0, 140)}`,
        url: leadUrl(r.lead),
        leadId: r.lead.id,
        now
      });
    }
  }
  return r;
}

/**
 * Whoever may handle a request marks the lead's open requests done, with an optional reply (one reply for all of them).
 * Only requests addressed to the actor's role are closed; each broker who asked is told. Returns { ok, lead, closed } | { error }.
 */
async function handleFlag(pool, actor, key, reply, { version = null, now = new Date() } = {}) {
  const text = String(reply ?? "").trim().slice(0, NOTE_MAX);
  const roles = Authz.isAgencyOwner(actor) ? ["manager", "owner"] : Authz.canManageLeads(actor) ? ["manager"] : null;
  if (!roles) return { error: "forbidden" };
  const found = await loadLead(pool, actor.agency_id, key);
  if (!found) return { error: "not_found" };
  const pending = (await pool.query("SELECT id, broker_id FROM lead_requests WHERE lead_id = $1 AND handled_at IS NULL AND to_role = ANY($2::text[])", [found.id, roles])).rows;
  if (!pending.length) return { unchanged: true };
  const r = await mutate(pool, actor, key, { kind: "flag_handled", version, manage: true, now }, () => ({ fields: {}, data: { reply: text || null, requests: pending.map((p) => p.id) } }));
  if (!r.ok) return r;
  await pool.query("UPDATE lead_requests SET handled_at = $2, handled_by = $3, reply = $4 WHERE id = ANY($1::uuid[]) AND handled_at IS NULL", [pending.map((p) => p.id), now.toISOString(), actor.id, text || null]);
  r.closed = pending.length;
  if (!r.lead.is_private) {
    for (const askedBy of new Set(pending.map((p) => p.broker_id).filter(Boolean))) {
      if (askedBy === actor.id) continue;
      const b = (await pool.query("SELECT id, agency_id, preferred_lang FROM brokers WHERE id = $1", [askedBy])).rows[0];
      if (!b) continue;
      await Notifications.notifyBroker(pool, b, {
        kind: "manager_alert",
        dedupeKey: `flag_done:${r.eventId}:${askedBy}`,
        title: L(b, `✅ ${actor.name} خلّص طلبك: ${Card.displayName(r.lead, b.preferred_lang)}`, `✅ ${actor.name} handled your request: ${Card.displayName(r.lead, b.preferred_lang)}`),
        body: text,
        url: leadUrl(r.lead),
        leadId: r.lead.id,
        now
      });
    }
  }
  return r;
}

/** Open requests this actor may handle, oldest first (name, ref, note, who asked, to whom). Null for a broker. */
async function openFlags(pool, actor) {
  if (!Authz.canManageLeads(actor)) return null;
  const roles = Authz.isAgencyOwner(actor) ? ["manager", "owner"] : ["manager"];
  const { rows } = await pool.query(
    `SELECT ${LEAD_COLS}, r.id AS request_id, r.note AS request_note, r.to_role, r.created_at AS requested_at, f.name AS flagged_by_name
       FROM lead_requests r JOIN leads l ON l.id = r.lead_id LEFT JOIN brokers a ON a.id = l.assigned_broker_id AND a.agency_id = l.agency_id
       LEFT JOIN brokers f ON f.id = r.broker_id
      WHERE ${Vis.leads("l")} AND l.agency_id = $1 AND r.handled_at IS NULL AND r.to_role = ANY($2::text[])
      ORDER BY r.created_at, l.ref`,
    [actor.agency_id, roles]
  );
  return rows;
}

/**
 * The open requests on one lead that the actor may see (a broker sees only their own; managers see all). Each row:
 * { id, note, to_role, broker_id, broker_name, created_at, mine }. Empty for a lead the actor may not see.
 */
async function openRequestsOn(pool, actor, leadId) {
  const { rows } = await pool.query(
    `SELECT r.id, r.note, r.to_role, r.broker_id, f.name AS broker_name, r.created_at
       FROM lead_requests r LEFT JOIN brokers f ON f.id = r.broker_id
      WHERE r.lead_id = $1 AND r.agency_id = $2 AND r.handled_at IS NULL ORDER BY r.created_at`,
    [leadId, actor.agency_id]
  );
  return rows
    .map((r) => ({ ...r, mine: r.broker_id === actor.id }))
    .filter((r) => r.mine || (r.to_role === "manager" && Authz.canManageLeads(actor)) || (r.to_role === "owner" && Authz.isAgencyOwner(actor)));
}

/** How many open requests wait on this actor (null for a broker: they have no such list). */
async function flagCount(pool, actor) {
  if (!Authz.canManageLeads(actor)) return null;
  const roles = Authz.isAgencyOwner(actor) ? ["manager", "owner"] : ["manager"];
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM lead_requests r JOIN leads l ON l.id = r.lead_id WHERE " + Vis.leads("l") + " AND l.agency_id = $1 AND r.handled_at IS NULL AND r.to_role = ANY($2::text[])",
    [actor.agency_id, roles]
  );
  return rows[0].n;
}

/**
 * The broker talked to the client: a new lead moves to contacted and its response deadline ends. The first contact by
 * the broker someone gave the lead to records how many minutes it took (speed-to-lead, R3).
 */
function contactChange(lead, actor, now) {
  const data = { from: lead.stage };
  if (!lead.last_contact_at && lead.assigned_at && lead.assigned_broker_id === actor.id && lead.created_by_broker_id !== actor.id) {
    data.response_min = Rules.minutesBetween(lead.assigned_at, now);
  }
  return { fields: { last_contact_at: now.toISOString(), stage: Stages.stageAfterContact(lead.stage), response_due_at: null }, data };
}

/** The broker talked to the client: a new lead moves to contacted. */
async function markContacted(pool, actor, key, { version = null, now = new Date() } = {}) {
  return mutate(pool, actor, key, { kind: "contacted", version, now }, (lead) => contactChange(lead, actor, now));
}

/** Q5: one open follow-up per lead (a new one replaces it). A viewing may carry a unit of the agency. */
async function setFollowUp(pool, actor, key, { at, kind = "call", listingId = null, note = null, version = null, now = new Date() } = {}) {
  const when = at instanceof Date ? at : new Date(at);
  if (!at || Number.isNaN(when.getTime())) return { error: "follow_up_time" };
  // A call or viewing is planned ahead: a time that has already passed is refused.
  if (when.getTime() <= now.getTime()) return { error: "follow_up_past" };
  if (!Stages.FOLLOW_UP_KINDS.includes(kind)) return { error: "follow_up_kind" };
  if (listingId) {
    const u = await pool.query("SELECT 1 FROM listings WHERE " + Vis.units("listings") + " AND id = $1 AND agency_id = $2", [listingId, actor.agency_id]);
    if (!u.rows.length) return { error: "unit_not_found" };
  }
  return mutate(pool, actor, key, { kind: "follow_up_set", version, now }, () => ({
    fields: { next_follow_up_at: when.toISOString(), follow_up_kind: kind, follow_up_listing_id: listingId, follow_up_note: cleanText(note, 300), follow_up_status: "open", follow_up_reminded_at: null },
    data: { at: when.toISOString(), kind, listing_id: listingId }
  }));
}

async function completeFollowUp(pool, actor, key, { version = null, now = new Date() } = {}) {
  return mutate(pool, actor, key, { kind: "follow_up_done", version, now }, (lead) =>
    lead.follow_up_status === "open" ? { fields: { follow_up_status: "done" }, data: { at: lead.next_follow_up_at, kind: lead.follow_up_kind || "call", note: lead.follow_up_note || null } } : { error: "no_open_follow_up" }
  );
}

/** "📅 Postpone": the open follow-up moves `days` Cairo days on at the same time of day (past now), kind and unit kept. */
async function postponeFollowUp(pool, actor, key, { days = 1, version = null, now = new Date() } = {}) {
  return mutate(pool, actor, key, { kind: "follow_up_set", version, now }, (lead) => {
    if (lead.follow_up_status !== "open" || !lead.next_follow_up_at) return { error: "no_open_follow_up" };
    let at = new Date(new Date(lead.next_follow_up_at).getTime() + days * DAY_MS);
    while (at <= now) at = new Date(at.getTime() + DAY_MS);
    return {
      fields: { next_follow_up_at: at.toISOString(), follow_up_reminded_at: null },
      data: { at: at.toISOString(), kind: lead.follow_up_kind, listing_id: lead.follow_up_listing_id, postponed: true }
    };
  });
}

/**
 * Reverts a reversible event within 10 minutes, if every later change was undone too (else a conflict).
 * @returns {Promise<{ ok, lead } | { error: "not_found"|"forbidden"|"not_undoable"|"undo_expired"|"already_undone" } | { conflict, lead }>}
 */
/** A team lead's own reassignment: undoable when the assignee it restores is in their team, or nobody. */
async function teamLeadMayUndoAssign(client, actor, ev) {
  if (!Authz.isTeamLead(actor) || ev.broker_id !== actor.id) return false;
  const prevId = ev.data?.prev?.assigned_broker_id || null;
  if (!prevId || prevId === actor.id) return true;
  const { rows } = await client.query("SELECT team_lead_id FROM brokers WHERE id = $1 AND agency_id = $2", [prevId, actor.agency_id]);
  return rows[0]?.team_lead_id === actor.id;
}

async function undo(pool, actor, eventId, { now = new Date() } = {}) {
  if (!/^\d+$/.test(String(eventId))) return { error: "not_found" };
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query("SELECT * FROM lead_events WHERE id = $1 AND agency_id = $2 FOR UPDATE", [eventId, actor.agency_id]);
    const ev = rows[0];
    if (!ev) return { error: "not_found" };
    const lead = await loadLead(client, actor.agency_id, ev.lead_id, { forUpdate: true });
    if (!lead) return { error: "not_found" };
    if (ev.kind === "assigned") {
      // A team lead may cancel their own reassignment when the assignee it restores is in their team (or nobody).
      if (!Authz.canManageLeads(actor) && !(await teamLeadMayUndoAssign(client, actor, ev))) return { error: "forbidden" };
    } else if (!Authz.canEditLead(actor, lead)) return { error: "forbidden" };
    if (!(ev.kind in REVERSIBLE)) return { error: "not_undoable" };
    if (ev.undone_at) return { error: "already_undone" };
    if (ev.broker_id !== actor.id && !Authz.isManager(actor)) return { error: "forbidden" };
    if (now.getTime() - new Date(ev.created_at).getTime() > UNDO_MS) return { error: "undo_expired" };
    // Undo works like a stack: only if every later change was itself undone (each change is an event).
    const later = await client.query(
      "SELECT 1 FROM lead_events WHERE agency_id = $1 AND lead_id = $2 AND id > $3 AND undone_at IS NULL AND kind <> 'undo' LIMIT 1",
      [actor.agency_id, lead.id, ev.id]
    );
    if (later.rows.length) return { conflict: true, lead };
    const prev = ev.data.prev || {};
    const cols = Object.keys(prev);
    const upd = await client.query(
      `UPDATE leads SET ${cols.map((col, i) => `${col} = $${i + 3}, `).join("")}updated_at = $${cols.length + 3}, version = version + 1
        WHERE id = $1 AND agency_id = $2 RETURNING *`,
      [lead.id, actor.agency_id, ...cols.map((col) => prev[col]), now.toISOString()]
    );
    await client.query("UPDATE lead_events SET undone_at = $3 WHERE id = $1 AND agency_id = $2", [ev.id, actor.agency_id, now.toISOString()]);
    await addEvent(client, lead, actor.id, "undo", { event_id: ev.id, kind: ev.kind }, now);
    return { ok: true, lead: upd.rows[0] };
  });
}

/** The timeline entry of a saved request (services/leadRequests.js holds the request itself). */
async function noteRequest(pool, actor, key, filters, { now = new Date(), requestId = null } = {}) {
  if (!filters || typeof filters !== "object") return { error: "request_empty" };
  return mutate(pool, actor, key, { kind: "request_set", now }, () => ({ fields: {}, data: { filters, ...(requestId ? { request_id: requestId } : {}) } }));
}

/** A unit sent to the client (services/leadRequests.js sendToClient): on the timeline, not undoable. */
async function logMatchSent(pool, actor, key, listing, { now = new Date() } = {}) {
  return mutate(pool, actor, key, { kind: "match_sent", now }, () => ({ fields: {}, data: { listing_id: listing.id, code: listing.code } }));
}

/* ---------------------------------------------------------------------- */
/* Reads (role-scoped in SQL)                                              */
/* ---------------------------------------------------------------------- */

/** The lead if the broker may see it, else null (a colleague's lead and another agency's look the same). */
/** The client's language (ar | en | null = the broker's). Only the client's messages use it; no timeline event, no screen change. */
async function setLang(pool, actor, key, lang, { version = null, now = new Date() } = {}) {
  const next = lang === "en" ? "en" : lang === "ar" ? "ar" : null;
  return withTransaction(pool, async (client) => {
    const lead = await loadLead(client, actor.agency_id, key, { forUpdate: true });
    if (!lead) return { error: "not_found" };
    if (!Authz.canEditLead(actor, lead)) return { error: "forbidden" };
    if (version !== null && version !== undefined && Number(version) !== lead.version) return { conflict: true, lead };
    if ((lead.lang || null) === next) return { unchanged: true, lead };
    const { rows } = await client.query(
      "UPDATE leads SET lang = $3, updated_at = $4, version = version + 1 WHERE id = $1 AND agency_id = $2 RETURNING *",
      [lead.id, actor.agency_id, next, now.toISOString()]
    );
    return { ok: true, lead: rows[0] };
  });
}

async function getLead(pool, actor, key) {
  const lead = await loadLead(pool, actor.agency_id, key);
  return lead && Authz.canViewLead(actor, lead) ? lead : null;
}

/**
 * "Who is calling?": the lead with this number, if the broker may see it.
 * @returns {Promise<{ lead: Object|null, elsewhere: boolean, invalid?: true }>} elsewhere: a colleague's lead
 */
async function findByPhone(pool, actor, raw) {
  const e164 = Phone.toE164(raw);
  if (!e164) return { lead: null, elsewhere: false, invalid: true };
  const { rows } = await pool.query(`SELECT ${LEAD_COLS} ${FROM_LEADS} WHERE ${Vis.leads("l")} AND l.agency_id = $1 AND l.phones @> ARRAY[$2]::text[] LIMIT 1`, [actor.agency_id, e164]);
  const lead = rows[0];
  if (!lead) return { lead: null, elsewhere: false };
  return Authz.canViewLead(actor, lead) ? { lead, elsewhere: false } : { lead: null, elsewhere: true };
}

/**
 * Pages of 20, newest activity first. Brokers see only their own leads; managers all, with a broker filter.
 * @param {Object} f - { q (name, phone digits or L- ref), stage, kind, source, brokerId ("none" = unassigned), noNextStep, overdue, dueToday, offset, limit }
 */
async function listLeads(pool, actor, f = {}, { now = new Date() } = {}) {
  const where = ["l.agency_id = $1"];
  const args = [actor.agency_id];
  const add = (sql, v) => {
    args.push(v);
    where.push(sql.replace("?", `$${args.length}`));
  };
  if (Authz.isTeamLead(actor)) {
    // A team lead's list: their own leads and the leads of brokers in their team.
    args.push(actor.id);
    where.push(`(l.assigned_broker_id = $${args.length} OR a.team_lead_id = $${args.length})`);
  } else if (!Authz.isManager(actor)) add("l.assigned_broker_id = ?", actor.id);
  else if (f.brokerId === "none") where.push("l.assigned_broker_id IS NULL");
  else if (f.brokerId && UUID.test(f.brokerId)) add("l.assigned_broker_id = ?", f.brokerId);
  if (f.stage && Stages.STAGES.includes(f.stage)) add("l.stage = ?", f.stage);
  if (f.kind && Stages.KINDS.includes(f.kind)) add("l.kind = ?", f.kind);
  if (f.source) add("l.source = ?", String(f.source));
  if (f.private && Authz.isAgencyOwner(actor)) where.push("l.is_private");
  if (f.noNextStep) where.push("l.follow_up_status IS DISTINCT FROM 'open' AND l.stage NOT IN ('won', 'lost')");
  if (f.overdue) add("l.follow_up_status = 'open' AND l.next_follow_up_at < ?", now.toISOString());
  if (f.dueToday) {
    add("l.follow_up_status = 'open' AND l.next_follow_up_at >= ?", Stages.cairoDayAt(now, 0, 0).toISOString());
    add("l.next_follow_up_at < ?", Stages.cairoDayAt(now, 1, 0).toISOString());
  }
  const q = String(f.q || "").trim();
  if (q) {
    const ref = Card.parseRef(q);
    const digits = Phone.toAsciiDigits(q).replace(/\D/g, "").replace(/^0+/, "");
    if (ref) add("l.ref = ?", ref);
    else if (digits.length >= 4 && /^[\d\s+\-().٠-٩]+$/.test(q)) add("EXISTS (SELECT 1 FROM unnest(l.phones) p WHERE p LIKE '%' || ? || '%')", digits);
    else add("l.name ILIKE '%' || ? || '%'", q.replace(/[%_\\]/g, (c) => `\\${c}`));
  }
  // Counts only (the app's tab numbers): the same filters, no rows.
  if (f.countOnly) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n ${FROM_LEADS} WHERE ${Vis.leads("l")} AND ${where.join(" AND ")}`, args);
    return { total: rows[0].n };
  }
  const limit = Math.min(Math.max(parseInt(f.limit, 10) || PAGE, 1), 100);
  const offset = Math.max(parseInt(f.offset, 10) || 0, 0);
  const { rows } = await pool.query(
    `SELECT ${LEAD_COLS} ${FROM_LEADS} WHERE ${Vis.leads("l")} AND ${where.join(" AND ")} ORDER BY l.last_activity_at DESC, l.ref DESC LIMIT ${limit + 1} OFFSET ${offset}`,
    args
  );
  const total = (await pool.query(`SELECT count(*)::int AS n ${FROM_LEADS} WHERE ${Vis.leads("l")} AND ${where.join(" AND ")}`, args)).rows[0].n;
  return { rows: rows.slice(0, limit), more: rows.length > limit, total };
}

/** True when the agency has a lead with this reference (visible or not): "not yours" rather than "no such lead". */
async function refExists(pool, actor, ref) {
  const { rows } = await pool.query("SELECT 1 FROM leads WHERE " + Vis.leads("leads") + " AND agency_id = $1 AND ref = $2", [actor.agency_id, ref]);
  return rows.length > 0;
}

/** «متابعات»: the broker's own open follow-ups, soonest first, and how many there are. */
async function dueFollowUps(pool, actor, { limit = 5 } = {}) {
  const { rows } = await pool.query(
    `SELECT ${LEAD_COLS}, count(*) OVER () AS total ${FROM_LEADS}
      WHERE ${Vis.leads("l")} AND l.agency_id = $1 AND l.assigned_broker_id = $2 AND l.follow_up_status = 'open'
      ORDER BY l.next_follow_up_at LIMIT $3`,
    [actor.agency_id, actor.id, limit]
  );
  return { rows, total: rows[0]?.total || 0 };
}

/** Managers' pipeline: leads per stage and overdue follow-ups per broker (null for a broker). */
async function pipeline(pool, actor, { now = new Date() } = {}) {
  if (!Authz.canManageLeads(actor)) return null;
  const stages = await pool.query("SELECT stage, count(*)::int AS n FROM leads WHERE " + Vis.leads("leads") + " AND agency_id = $1 GROUP BY stage", [actor.agency_id]);
  const overdue = await pool.query(
    `SELECT l.assigned_broker_id AS broker_id, b.name, count(*)::int AS n
       FROM leads l LEFT JOIN brokers b ON b.id = l.assigned_broker_id AND b.agency_id = l.agency_id
      WHERE ${Vis.leads("l")} AND l.agency_id = $1 AND l.follow_up_status = 'open' AND l.next_follow_up_at < $2
      GROUP BY l.assigned_broker_id, b.name ORDER BY n DESC`,
    [actor.agency_id, now.toISOString()]
  );
  const byStage = Object.fromEntries(Stages.STAGES.map((s) => [s, 0]));
  for (const r of stages.rows) byStage[r.stage] = r.n;
  // The VIP and Portal cards: VIP leads the viewer can see, and Portal enquiries nobody has taken yet.
  const vip = await pool.query("SELECT count(*)::int AS n FROM leads WHERE " + Vis.leads("leads") + " AND agency_id = $1 AND is_private", [actor.agency_id]);
  const portal = await pool.query("SELECT count(*)::int AS n FROM portal_enquiries WHERE agency_id = $1 AND assigned_broker_id IS NULL AND lead_id IS NULL", [actor.agency_id]);
  return { stages: byStage, overdue: overdue.rows, vip: vip.rows[0].n, portal: portal.rows[0].n };
}

/** The last 20 events (then "older" with beforeId), with the acting broker's name. Null if the lead isn't visible. */
async function timeline(pool, actor, key, { limit = PAGE, beforeId = null } = {}) {
  const lead = await getLead(pool, actor, key);
  if (!lead) return null;
  const { rows } = await pool.query(
    `SELECT e.id, e.kind, e.data, e.created_at, e.undone_at, e.broker_id, b.name AS broker_name
       FROM lead_events e LEFT JOIN brokers b ON b.id = e.broker_id AND b.agency_id = e.agency_id
      WHERE e.agency_id = $1 AND e.lead_id = $2 AND ($3::bigint IS NULL OR e.id < $3)
      ORDER BY e.id DESC LIMIT $4`,
    [actor.agency_id, lead.id, beforeId, limit + 1]
  );
  return { lead, rows: rows.slice(0, limit), more: rows.length > limit };
}

/* ---------------------------------------------------------------------- */
/* History with filters (date, person)                                     */
/* ---------------------------------------------------------------------- */

/**
 * A team lead's view of a lead's history: the actions of brokers who were in their team at the time (the broker_team_history
 * dates), so after a broker moves, the old team lead keeps the old logs and sees nothing new for that broker.
 * `p` is the parameter number that holds the team lead's id.
 */
const teamEventSql = (ph) =>
  `EXISTS (SELECT 1 FROM broker_team_history h WHERE h.team_lead_id = ${ph} AND h.broker_id = e.broker_id AND h.agency_id = e.agency_id
            AND e.created_at >= h.from_at AND (h.to_at IS NULL OR e.created_at < h.to_at))`;

/**
 * The history page: a lead's events, newest first, filtered by from/to (instants) and by the acting person (brokerId).
 * Managers see all of it. A team lead sees their team's brokers' actions (see teamEventSql); a lead with no such events
 * is not theirs to read. Brokers see what the lead page shows. Null when it isn't visible.
 */
async function historyFor(pool, actor, key, { from = null, to = null, brokerId = null, beforeId = null, limit = PAGE } = {}) {
  const k = keyClause(key);
  if (!k) return null;
  const teamLead = !Authz.isManager(actor) && Authz.isTeamLead(actor);
  let lead = await getLead(pool, actor, key);
  if (!lead && teamLead) {
    const { rows } = await pool.query(
      `SELECT l.* FROM leads l WHERE ${Vis.leads("l")} AND l.agency_id = $1 AND ${k.sql}
          AND EXISTS (SELECT 1 FROM lead_events e WHERE e.lead_id = l.id AND e.agency_id = l.agency_id AND ${teamEventSql("$3")}) LIMIT 1`,
      [actor.agency_id, k.value, actor.id]
    );
    lead = rows[0] || null;
  }
  if (!lead) return null;
  const args = [actor.agency_id, lead.id];
  const where = ["e.agency_id = $1", "e.lead_id = $2"];
  const add = (sql, v) => {
    args.push(v);
    where.push(sql.replace("?", `$${args.length}`));
  };
  if (teamLead) add(teamEventSql("?"), actor.id);
  if (from) add("e.created_at >= ?", from);
  if (to) add("e.created_at < ?", to);
  if (brokerId) add("e.broker_id = ?", brokerId);
  if (beforeId) add("e.id < ?", beforeId);
  args.push(limit + 1);
  const { rows } = await pool.query(
    `SELECT e.id, e.kind, e.data, e.created_at, e.undone_at, e.broker_id, b.name AS broker_name
       FROM lead_events e LEFT JOIN brokers b ON b.id = e.broker_id AND b.agency_id = e.agency_id
      WHERE ${where.join(" AND ")} ORDER BY e.id DESC LIMIT $${args.length}`,
    args
  );
  return { lead, rows: rows.slice(0, limit), more: rows.length > limit };
}

/** The people a history page can filter by: all of the agency's brokers for managers; a team lead's team members. */
async function historyPeople(pool, actor) {
  if (Authz.isManager(actor)) {
    const { rows } = await pool.query("SELECT id, name FROM brokers WHERE agency_id = $1 ORDER BY name, id", [actor.agency_id]);
    return rows;
  }
  if (!Authz.isTeamLead(actor)) return [];
  const { rows } = await pool.query(
    "SELECT DISTINCT b.id, b.name FROM broker_team_history h JOIN brokers b ON b.id = h.broker_id WHERE h.team_lead_id = $1 AND h.agency_id = $2 ORDER BY b.name, b.id",
    [actor.id, actor.agency_id]
  );
  return rows;
}

/* ---------------------------------------------------------------------- */
/* A broker leaves (P6)                                                    */
/* ---------------------------------------------------------------------- */

/** Their leads go to the unassigned pool; the managers get one notification with the count. */
async function releaseBrokerLeads(pool, agencyId, brokerId, { actorId = null, now = new Date() } = {}) {
  const released = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `UPDATE leads SET assigned_broker_id = NULL, assigned_at = NULL, response_due_at = NULL, updated_at = $3, version = version + 1
        WHERE agency_id = $1 AND assigned_broker_id = $2 RETURNING id`,
      [agencyId, brokerId, now.toISOString()]
    );
    if (rows.length) {
      await client.query(
        `INSERT INTO lead_events (agency_id, lead_id, broker_id, kind, data, created_at)
         SELECT $1, id, $2, 'assigned', jsonb_build_object('from', $3::text, 'to', NULL, 'reason', 'deactivated'), $4 FROM unnest($5::uuid[]) AS id`,
        [agencyId, actorId, brokerId, now.toISOString(), rows.map((r) => r.id)]
      );
    }
    return rows.length;
  });
  if (released) {
    const gone = await brokerById(pool, agencyId, brokerId);
    for (const m of await Notifications.managersOf(pool, agencyId)) {
      await Notifications.notifyBroker(pool, m, {
        kind: "manager_alert",
        dedupeKey: `leads_released:${brokerId}:${now.toISOString()}`,
        title: L(m, `🧑‍💼 ${released} عميل محتاجين يتسلموا`, `🧑‍💼 ${released} lead(s) to reassign`),
        body: L(m, `كانوا مع ${gone?.name || "—"} (اتوقف حسابه).`, `They were with ${gone?.name || "—"} (deactivated).`),
        url: "/app/leads?broker=none",
        now
      });
    }
  }
  return { count: released };
}

module.exports = {
  historyFor,
  historyPeople,
  MAX_PHONES,
  UNDO_MS,
  phoneHash,
  wasErased,
  normalizePhones,
  captureLead,
  assignLead,
  setStage,
  addNote,
  flagForManager,
  handleFlag,
  openFlags,
  flagCount,
  openRequestsOn,
  markContacted,
  setFollowUp,
  completeFollowUp,
  postponeFollowUp,
  applyUpdate,
  setLang,
  undoMany,
  recordDeal,
  undo,
  noteRequest,
  logMatchSent,
  getLead,
  refExists,
  dueFollowUps,
  pipeline,
  findByPhone,
  listLeads,
  timeline,
  releaseBrokerLeads
};
