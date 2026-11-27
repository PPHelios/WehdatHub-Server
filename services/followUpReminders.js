// services/followUpReminders.js — Follow-up and viewing reminders, and the 24-hour "not contacted" nudge (Release 3
// step 8). A scheduler job claims the due follow-ups (FOR UPDATE SKIP LOCKED, stamping follow_up_reminded_at), so two
// instances never remind twice, and tells each lead's current broker once per run, grouped (5 lines and "and N
// more"). A single reminder carries [✅ Done] [📅 Postpone]; a viewing carries the unit's compact line and its place.
// Quiet hours hold the message until they end (lib/notifications.js). A new lead nobody has contacted 24 hours after
// it arrived gets one nudge to its broker. A lead marked Interested with no follow-up planned and nothing happening for
// 24 hours gets one nudge too (6.5), again only after new activity and another quiet day.
"use strict";

const crypto = require("crypto");
const Notifications = require("../lib/notifications");
const Card = require("../domain/leadCard");
const Phone = require("../domain/phone");
const Describe = require("../domain/describe");
const Rules = require("../domain/leadRules");
const { withTransaction } = require("../lib/db");
const Vis = require("../lib/visibility");

const BATCH = 200;
const LINES = 5;
const NUDGE_AFTER_MS = 24 * 3600 * 1000;
const NUDGE_WINDOW_MS = 72 * 3600 * 1000; // older untouched leads (first deploy, old imports) are never nudged
const BROKER_COLS = "id, agency_id, name, role, is_active, preferred_lang, phone_number, phone_normalized, notify_prefs, away_until";

const en = (b) => b?.preferred_lang === "en";
const L = (b, ar, eng) => (en(b) ? eng : ar);
const latin = (s) => (s && !/[؀-ۿ]/.test(s) ? s : null);
const time = (d, b) => new Date(d).toLocaleTimeString(en(b) ? "en-GB" : "ar-EG", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit" });
// A reminder's key: the lead and the moment it is for (the follow-up time and the lead times sent with it), so each lead time
// of one follow-up is its own message, and the same one is never sent twice.
const reminderKeyOf = (r) => (r.reminder_key ? r.reminder_key : new Date(r.next_follow_up_at).toISOString());
const dedupe = (prefix, rows, field) => `${prefix}:${crypto.createHash("sha1").update(rows.map((r) => `${r.id}@${field === "reminder_key" ? reminderKeyOf(r) : new Date(r[field]).toISOString()}`).sort().join(",")).digest("hex").slice(0, 20)}`;

/** "📍 Mivida، New Cairo": where a viewing is. */
function placeLine(listing, broker) {
  const parts = en(broker)
    ? [listing.compound_en || latin(listing.compound), latin(listing.district), latin(listing.city)]
    : [listing.compound || listing.compound_en, listing.district, listing.city];
  const uniq = [...new Set(parts.filter(Boolean))];
  return uniq.length ? `📍 ${uniq.join("، ")}` : listing.location ? `📍 ${listing.location}` : null;
}

/** One lead's line in a grouped reminder. */
function reminderLine(lead, broker) {
  const lang = en(broker) ? "en" : "ar";
  const unit = lead.listing ? ` · 🏠 ${lead.listing.code}` : lead.follow_up_kind === "viewing" ? L(broker, " · 🏠 معاينة", " · 🏠 viewing") : "";
  return `• ${time(lead.next_follow_up_at, broker)} · ${Card.refLabel(lead.ref)} ${Card.displayName(lead, lang)}${unit}`;
}

/** The notification for one broker's due follow-ups. */
function reminderMessage(broker, leads) {
  const lang = en(broker) ? "en" : "ar";
  if (leads.length === 1) {
    const lead = leads[0];
    const ref = Card.refLabel(lead.ref);
    const who = `${Card.displayName(lead, lang)} (${ref})`;
    const viewing = lead.follow_up_kind === "viewing";
    const body = [];
    if (viewing && lead.listing) body.push(Describe.compactLine(lead.listing, lang), placeLine(lead.listing, broker));
    if (lead.follow_up_note) body.push(`📝 ${lead.follow_up_note}`);
    if (lead.phone_e164) body.push(`📞 ${Phone.displayPhone(lead.phone_e164)}`);
    return {
      title: viewing
        ? L(broker, `🏠 معاينة ${time(lead.next_follow_up_at, broker)}: ${who}`, `🏠 Viewing at ${time(lead.next_follow_up_at, broker)}: ${who}`)
        : L(broker, `📅 متابعة: ${who}`, `📅 Follow-up: ${who}`),
      body: body.filter(Boolean).join("\n"),
      url: `/app/leads/${ref}`,
      leadId: lead.id,
      listingId: lead.listing?.id || null,
      buttons: [
        { id: `ld:fudone:${ref}`, title: L(broker, "✅ خلصت", "✅ Done") },
        { id: `ld:fupost:${ref}`, title: L(broker, "📅 أجّل يوم", "📅 Postpone") }
      ]
    };
  }
  const lines = leads.slice(0, LINES).map((l) => reminderLine(l, broker));
  if (leads.length > LINES) lines.push(L(broker, `…و${leads.length - LINES} كمان`, `…and ${leads.length - LINES} more`));
  return {
    title: L(broker, `📅 ${leads.length} متابعات دلوقتي`, `📅 ${leads.length} follow-ups due`),
    body: lines.join("\n"),
    url: "/app/leads?overdue=1",
    leadId: null,
    listingId: null,
    buttons: null
  };
}

/**
 * Sends one grouped notification per broker. A broker away (R3) is not disturbed: the managers get it instead, titled
 * with whose leads they are. → number of brokers told
 */
async function tellBrokers(pool, byBroker, build, prefix, field, now) {
  let told = 0;
  for (const [brokerId, { agencyId, leads }] of byBroker) {
    const { rows } = await pool.query(`SELECT ${BROKER_COLS} FROM brokers WHERE id = $1 AND agency_id = $2`, [brokerId, agencyId]);
    const broker = rows[0];
    if (!broker || !broker.is_active) continue;
    if (Rules.awayNow(broker, now)) {
      for (const m of await Notifications.managersOf(pool, agencyId)) {
        if (m.id === broker.id) continue;
        const msg = build(m, leads);
        const title = `${msg.title} · ${L(m, `بدل ${broker.name} (إجازة)`, `for ${broker.name} (away)`)}`;
        // The body names the broker too: the manager reads whose lead this is.
        msg.body = `${L(m, "البروكر", "Broker")}: ${broker.name}\n${msg.body}`;
        await Notifications.notifyBroker(pool, m, { kind: "follow_up", dedupeKey: `${dedupe(prefix, leads, field)}:${broker.id}`, ...msg, title, buttons: null, now });
      }
      told++;
      continue;
    }
    const m = build(broker, leads);
    // Calls and viewings are not held by quiet hours: a reminder for 08:00 must not wait for the morning message.
    await Notifications.notifyBroker(pool, broker, { kind: "follow_up", dedupeKey: dedupe(prefix, leads, field), ...m, now, urgent: true });
    told++;
  }
  return told;
}

const groupByBroker = (rows) => {
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.assigned_broker_id)) out.set(r.assigned_broker_id, { agencyId: r.agency_id, leads: [] });
    out.get(r.assigned_broker_id).leads.push(r);
  }
  return out;
};

/** How far ahead of a follow-up the job looks: the longest lead time anyone can pick. */
const LOOK_AHEAD_MIN = 120;

/** Claims and reminds the due follow-ups, one reminder per lead time the broker asked for. → { reminded, brokers } */
async function remindDue(pool, { now = new Date(), limit = BATCH } = {}) {
  const claimed = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT leads.*, b.notify_prefs AS broker_prefs FROM leads
         JOIN brokers b ON b.id = leads.assigned_broker_id
        WHERE ${Vis.leads("leads")} AND leads.follow_up_status = 'open' AND leads.next_follow_up_at <= $1
          AND leads.assigned_broker_id IS NOT NULL AND leads.stage NOT IN ('won', 'lost')
        ORDER BY leads.next_follow_up_at, leads.id LIMIT $2 FOR UPDATE OF leads SKIP LOCKED`,
      [new Date(now.getTime() + LOOK_AHEAD_MIN * 60000).toISOString(), limit]
    );
    const out = [];
    for (const r of rows) {
      const sent = r.follow_up_reminded_steps || [];
      const minutes = Notifications.prefsOf({ notify_prefs: r.broker_prefs }).reminderMinutes;
      const at = new Date(r.next_follow_up_at).getTime();
      // The lead times whose moment has come and that were not sent yet. A follow-up booked late gets all of them in one message.
      const passed = minutes.filter((m) => !sent.includes(m) && at - m * 60000 <= now.getTime());
      if (!passed.length) continue;
      const steps = [...new Set([...sent, ...passed])].sort((a, b) => a - b);
      await client.query("UPDATE leads SET follow_up_reminded_steps = $2::int[], follow_up_reminded_at = $3 WHERE id = $1", [r.id, steps, now.toISOString()]);
      delete r.broker_prefs;
      out.push({ ...r, reminder_key: `${new Date(r.next_follow_up_at).toISOString()}#${passed.join("-")}` });
    }
    return out;
  });
  if (!claimed.length) return { reminded: 0, brokers: 0 };
  const unitIds = [...new Set(claimed.map((l) => l.follow_up_listing_id).filter(Boolean))];
  const units = unitIds.length ? (await pool.query("SELECT * FROM listings WHERE " + Vis.units("listings") + " AND id = ANY($1::uuid[])", [unitIds])).rows : [];
  const byId = new Map(units.map((u) => [u.id, u]));
  for (const l of claimed) l.listing = byId.get(l.follow_up_listing_id) || null;
  claimed.sort((a, b) => new Date(a.next_follow_up_at) - new Date(b.next_follow_up_at));
  const brokers = await tellBrokers(pool, groupByBroker(claimed), reminderMessage, "fu", "reminder_key", now);
  return { reminded: claimed.length, brokers };
}

/** The nudge for one broker's untouched new leads. */
function nudgeMessage(broker, leads) {
  const lang = en(broker) ? "en" : "ar";
  if (leads.length === 1) {
    const lead = leads[0];
    const ref = Card.refLabel(lead.ref);
    return {
      title: L(broker, `⏰ ${Card.displayName(lead, lang)} (${ref}) لسه محدش كلمه من 24 ساعة`, `⏰ Nobody has contacted ${Card.displayName(lead, lang)} (${ref}) in 24 hours`),
      body: lead.phone_e164 ? `📞 ${Phone.displayPhone(lead.phone_e164)}` : "",
      url: `/app/leads/${ref}`,
      leadId: lead.id,
      buttons: [
        { id: `ld:called:${ref}`, title: L(broker, "📞 كلمته", "📞 Called") },
        { id: `ld:fu:${ref}`, title: L(broker, "📅 متابعة", "📅 Follow-up") }
      ]
    };
  }
  const lines = leads.slice(0, LINES).map((l) => `• ${Card.refLabel(l.ref)} ${Card.displayName(l, lang)}`);
  if (leads.length > LINES) lines.push(L(broker, `…و${leads.length - LINES} كمان`, `…and ${leads.length - LINES} more`));
  return {
    title: L(broker, `⏰ ${leads.length} عملاء جداد لسه محدش كلمهم`, `⏰ ${leads.length} new clients not contacted yet`),
    body: lines.join("\n"),
    url: "/app/leads?tab=new",
    buttons: null
  };
}

/** One nudge per new lead still uncontacted 24 hours after it arrived (replaced when agency round-robin SLA is active or broker updated). */
async function nudgeUntouched(pool, { now = new Date(), limit = BATCH } = {}) {
  const { UPDATE_EVENT_KINDS } = require("../domain/discipline");
  const claimed = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT l.id FROM leads l
        WHERE ${Vis.leads("l")} AND l.stage = 'new' AND l.last_contact_at IS NULL AND l.nudged_at IS NULL AND l.assigned_broker_id IS NOT NULL
          AND l.follow_up_status IS DISTINCT FROM 'open'
          AND l.response_due_at IS NULL
          AND coalesce(l.response_jumps, 0) = 0
          AND NOT EXISTS (
            SELECT 1 FROM lead_events e
             WHERE e.lead_id = l.id AND e.agency_id = l.agency_id AND e.broker_id IS NOT NULL
               AND e.undone_at IS NULL AND e.kind = ANY($4::text[])
          )
          AND l.created_at <= $1 AND l.created_at > $2
        ORDER BY l.created_at, l.id LIMIT $3 FOR UPDATE OF l SKIP LOCKED`,
      [new Date(now.getTime() - NUDGE_AFTER_MS).toISOString(), new Date(now.getTime() - NUDGE_WINDOW_MS).toISOString(), limit, UPDATE_EVENT_KINDS]
    );
    if (!rows.length) return [];
    const upd = await client.query("UPDATE leads SET nudged_at = $2 WHERE id = ANY($1::uuid[]) RETURNING *", [rows.map((r) => r.id), now.toISOString()]);
    return upd.rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  });
  if (!claimed.length) return { nudged: 0, brokers: 0 };
  const brokers = await tellBrokers(pool, groupByBroker(claimed), nudgeMessage, "nudge", "created_at", now);
  return { nudged: claimed.length, brokers };
}

const INTEREST_QUIET_MS = 24 * 3600 * 1000;

/** The nudge for one broker's interested leads with no next step. */
function interestMessage(broker, leads) {
  const lang = en(broker) ? "en" : "ar";
  if (leads.length === 1) {
    const lead = leads[0];
    const ref = Card.refLabel(lead.ref);
    return {
      title: L(broker, `👍 ${Card.displayName(lead, lang)} (${ref}) مهتم ومفيش متابعة متحددة`, `👍 ${Card.displayName(lead, lang)} (${ref}) is interested but has no follow-up`),
      body: lead.phone_e164 ? `📞 ${Phone.displayPhone(lead.phone_e164)}` : "",
      url: `/app/leads/${ref}`,
      leadId: lead.id,
      buttons: [
        { id: `ld:fu:${ref}`, title: L(broker, "📅 متابعة", "📅 Follow-up") },
        { id: `ld:called:${ref}`, title: L(broker, "📞 كلمته", "📞 Called") }
      ]
    };
  }
  const lines = leads.slice(0, LINES).map((l) => `• ${Card.refLabel(l.ref)} ${Card.displayName(l, lang)}`);
  if (leads.length > LINES) lines.push(L(broker, `…و${leads.length - LINES} كمان`, `…and ${leads.length - LINES} more`));
  return {
    title: L(broker, `👍 ${leads.length} عملاء مهتمين ومفيش متابعة متحددة`, `👍 ${leads.length} interested clients with no follow-up`),
    body: lines.join("\n"),
    url: "/app/leads?stage=interested",
    buttons: null
  };
}

/** One nudge per interested lead with no open follow-up and no activity for 24 hours (again after new activity). */
async function nudgeInterested(pool, { now = new Date(), limit = BATCH } = {}) {
  const claimed = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT id FROM leads
        WHERE ${Vis.leads("leads")} AND stage = 'interested' AND assigned_broker_id IS NOT NULL AND follow_up_status IS DISTINCT FROM 'open'
          AND last_activity_at <= $1 AND (interest_nudged_at IS NULL OR interest_nudged_at < last_activity_at)
        ORDER BY last_activity_at, id LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [new Date(now.getTime() - INTEREST_QUIET_MS).toISOString(), limit]
    );
    if (!rows.length) return [];
    // A stamp, not activity: last_activity_at and version stay.
    const upd = await client.query("UPDATE leads SET interest_nudged_at = $2 WHERE id = ANY($1::uuid[]) RETURNING *", [rows.map((r) => r.id), now.toISOString()]);
    return upd.rows.sort((a, b) => a.ref - b.ref);
  });
  if (!claimed.length) return { nudged: 0, brokers: 0 };
  const brokers = await tellBrokers(pool, groupByBroker(claimed), interestMessage, "interest", "interest_nudged_at", now);
  return { nudged: claimed.length, brokers };
}

const POST_VIEWING_AFTER_MS = 2 * 3600 * 1000;
const POST_VIEWING_WINDOW_MS = 48 * 3600 * 1000;
const LINK_SILENCE_AFTER_MS = 2 * 3600 * 1000;
const LINK_SILENCE_WINDOW_MS = 24 * 3600 * 1000;

function postViewingMessage(broker, leads) {
  const lang = en(broker) ? "en" : "ar";
  if (leads.length === 1) {
    const lead = leads[0];
    const ref = Card.refLabel(lead.ref);
    const who = `${Card.displayName(lead, lang)} (${ref})`;
    return {
      title: L(broker, `🏠 إيه نتيجة معاينة ${who}؟`, `🏠 How did ${who}'s viewing go?`),
      body: L(broker, "اختار المرحلة الجاية (وبعدها تقدر تضيف ملاحظة لو حابب):", "Pick the next stage (you can add a status note right after):"),
      url: `/app/leads/${ref}`,
      leadId: lead.id,
      buttons: [
        { id: `ld:st:${ref}:interested`, title: L(broker, "👍 مهتم", "👍 Interested") },
        { id: `ld:st:${ref}:negotiation`, title: L(broker, "🤝 تفاوض", "🤝 Negotiation") },
        { id: `ld:fu:${ref}`, title: L(broker, "📅 متابعة", "📅 Follow-up") },
        { id: `ld:st:${ref}:lost`, title: L(broker, "❌ مش مناسب", "❌ Not fit") }
      ]
    };
  }
  const lines = leads.slice(0, LINES).map((l) => `• ${Card.refLabel(l.ref)} ${Card.displayName(l, lang)}`);
  if (leads.length > LINES) lines.push(L(broker, `…و${leads.length - LINES} كمان`, `…and ${leads.length - LINES} more`));
  return {
    title: L(broker, `🏠 ${leads.length} معاينات خلصت ولسه متسجّلش نتيجتها`, `🏠 ${leads.length} viewings waiting for an outcome update`),
    body: lines.join("\n"),
    url: "/app/leads?tab=overdue",
    buttons: null
  };
}

/**
 * 2h post-viewing outcome check-in (Phase 4): replaces generic quiet-day reminders for viewings where the broker
 * has not logged any update/note/stage change after `next_follow_up_at`.
 */
async function nudgePostViewing(pool, { now = new Date(), limit = BATCH } = {}) {
  const claimed = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT id FROM leads
        WHERE ${Vis.leads("leads")}
          AND follow_up_status = 'open'
          AND follow_up_kind = 'viewing'
          AND assigned_broker_id IS NOT NULL
          AND stage NOT IN ('won', 'lost')
          AND post_viewing_nudged_at IS NULL
          AND next_follow_up_at <= $1
          AND next_follow_up_at > $2
          AND (last_activity_at IS NULL OR last_activity_at <= next_follow_up_at)
        ORDER BY next_follow_up_at, id LIMIT $3 FOR UPDATE SKIP LOCKED`,
      [new Date(now.getTime() - POST_VIEWING_AFTER_MS).toISOString(), new Date(now.getTime() - POST_VIEWING_WINDOW_MS).toISOString(), limit]
    );
    if (!rows.length) return [];
    // Also stamp interest_nudged_at so nudgeInterested does not double-notify after a viewing.
    const upd = await client.query(
      "UPDATE leads SET post_viewing_nudged_at = $2, interest_nudged_at = GREATEST(coalesce(interest_nudged_at, $2), $2) WHERE id = ANY($1::uuid[]) RETURNING *",
      [rows.map((r) => r.id), now.toISOString()]
    );
    return upd.rows.sort((a, b) => new Date(a.next_follow_up_at) - new Date(b.next_follow_up_at));
  });
  if (!claimed.length) return { nudged: 0, brokers: 0 };
  const brokers = await tellBrokers(pool, groupByBroker(claimed), postViewingMessage, "post_view", "post_viewing_nudged_at", now);
  return { nudged: claimed.length, brokers };
}

function linkSilenceMessage(broker, leads) {
  const lang = en(broker) ? "en" : "ar";
  if (leads.length === 1) {
    const lead = leads[0];
    const ref = Card.refLabel(lead.ref);
    const who = `${Card.displayName(lead, lang)} (${ref})`;
    return {
      title: L(broker, `👀 ${who} فتح عرضك من ساعتين`, `👀 ${who} opened your unit link 2h ago`),
      body: L(broker, "لسه مفيش تحديث بعد فتح اللينك — كلمه أو حط متابعة:", "No follow-up logged since they opened — reach out or set next step:"),
      url: `/app/leads/${ref}`,
      leadId: lead.id,
      buttons: [
        { id: `ld:called:${ref}`, title: L(broker, "📞 كلمته", "📞 Called") },
        { id: `ld:fu:${ref}`, title: L(broker, "📅 متابعة", "📅 Follow-up") },
        { id: `ld:stage:${ref}`, title: L(broker, "🔄 المرحلة", "🔄 Stage") }
      ]
    };
  }
  const lines = leads.slice(0, LINES).map((l) => `• ${Card.refLabel(l.ref)} ${Card.displayName(l, lang)}`);
  if (leads.length > LINES) lines.push(L(broker, `…و${leads.length - LINES} كمان`, `…and ${leads.length - LINES} more`));
  return {
    title: L(broker, `👀 ${leads.length} عملاء فتحوا عروضك ومفيش تحديث`, `👀 ${leads.length} clients opened links with no update`),
    body: lines.join("\n"),
    url: "/app/leads",
    buttons: null
  };
}

/**
 * 2h opened-link silence check (Phase 4): reminds once when a client opened a unit link >= 2h ago and no activity
 * occurred since, skipping leads that already got a recent hot-client alert within 4h.
 */
async function nudgeLinkSilence(pool, { now = new Date(), limit = BATCH } = {}) {
  const after = new Date(now.getTime() - LINK_SILENCE_AFTER_MS).toISOString();
  const winStart = new Date(now.getTime() - LINK_SILENCE_WINDOW_MS).toISOString();
  const hotCooldown = new Date(now.getTime() - 4 * 3600 * 1000).toISOString();
  const claimed = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT l.id FROM leads l
         JOIN LATERAL (
           SELECT max(e.created_at) AS opened_at FROM lead_events e
            WHERE e.lead_id = l.id AND e.agency_id = l.agency_id AND e.kind = 'share_opened'
              AND e.created_at <= $1 AND e.created_at > $2
         ) so ON so.opened_at IS NOT NULL
        WHERE ${Vis.leads("l")}
          AND l.assigned_broker_id IS NOT NULL
          AND l.stage NOT IN ('won', 'lost')
          AND (l.link_silence_nudged_at IS NULL OR l.link_silence_nudged_at < so.opened_at)
          AND (l.last_activity_at IS NULL OR l.last_activity_at < so.opened_at)
          AND (l.hot_at IS NULL OR l.hot_at < $3)
        ORDER BY so.opened_at, l.id LIMIT $4 FOR UPDATE OF l SKIP LOCKED`,
      [after, winStart, hotCooldown, limit]
    );
    if (!rows.length) return [];
    const upd = await client.query("UPDATE leads SET link_silence_nudged_at = $2 WHERE id = ANY($1::uuid[]) RETURNING *", [rows.map((r) => r.id), now.toISOString()]);
    return upd.rows.sort((a, b) => a.ref - b.ref);
  });
  if (!claimed.length) return { nudged: 0, brokers: 0 };
  const brokers = await tellBrokers(pool, groupByBroker(claimed), linkSilenceMessage, "link_silence", "link_silence_nudged_at", now);
  return { nudged: claimed.length, brokers };
}

/** The scheduler job entry (lib/jobs.js). */
const reminderJob = () => ({
  name: "follow_up_reminders",
  everyMs: 60 * 1000,
  run: async ({ pool, now }) => {
    const r = await remindDue(pool, { now });
    const n = await nudgeUntouched(pool, { now });
    const i = await nudgeInterested(pool, { now });
    const pv = await nudgePostViewing(pool, { now });
    const ls = await nudgeLinkSilence(pool, { now });
    return { counts: { reminded: r.reminded, nudged: n.nudged, interest: i.nudged, postViewing: pv.nudged, linkSilence: ls.nudged, brokers: r.brokers + n.brokers + i.brokers + pv.brokers + ls.brokers } };
  }
});

module.exports = { remindDue, nudgeUntouched, nudgeInterested, nudgePostViewing, nudgeLinkSilence, reminderMessage, nudgeMessage, interestMessage, postViewingMessage, linkSilenceMessage, reminderJob };
