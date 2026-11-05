// services/linkPicker.js — Telegram: after a client copy (the bot's unit text with its link), the broker picks who it is for:
// a number, a lead ID (L-0042) or a shared contact, or skips. A number that is not a lead yet is added as a new lead: the
// bot asks the client's name (skip makes the number the name), and the sending broker is its assignee. A shared contact
// brings its name. Skipping the whole choice leaves the link with no recipient. The choice waits 10 minutes in
// broker_sessions. Only the link the copy just made is attached. WhatsApp keeps the copy alone (its buttons are limited).
"use strict";

const Phone = require("../domain/phone");
const Recipients = require("./linkRecipients");
const Leads = require("./leads");

const SESSION = "link_pick";
const TTL_MIN = 10;
const RECENT_MS = 2 * 60 * 1000;

const saveSession = (pool, brokerId, data) =>
  pool.query(
    `INSERT INTO broker_sessions (broker_id, session_type, session_data, expires_at)
     VALUES ($1::uuid, $2, $3::jsonb, NOW() + make_interval(mins => $4))
     ON CONFLICT (broker_id, session_type) DO UPDATE SET session_data = EXCLUDED.session_data, expires_at = EXCLUDED.expires_at`,
    [brokerId, SESSION, JSON.stringify(data), TTL_MIN]
  );

async function pending(pool, broker) {
  const { rows } = await pool.query("SELECT session_data FROM broker_sessions WHERE broker_id = $1 AND session_type = $2 AND expires_at > NOW()", [broker.id, SESSION]);
  return rows[0]?.session_data || null;
}

const clearSession = (pool, brokerId) => pool.query("DELETE FROM broker_sessions WHERE broker_id = $1 AND session_type = $2", [brokerId, SESSION]);

/** The buttons under a client copy (Telegram only): who it is for, or skip. */
function buttons(lang) {
  const en = lang === "en";
  return [
    { id: "lk:num", title: en ? "📱 By number" : "📱 برقم" },
    { id: "lk:id", title: en ? "🆔 By lead ID" : "🆔 برقم العميل" },
    { id: "lk:contact", title: en ? "📇 From contact" : "📇 من جهة الاتصال" },
    { id: "lk:skip", title: en ? "⏭️ Skip" : "⏭️ تخطي" }
  ];
}

/** After a client copy: remember the link it just made, so the broker's answer attaches to that one. */
async function offer(pool, broker, listing) {
  const { rows } = await pool.query(
    `SELECT token_hash FROM share_links WHERE agency_id = $1 AND broker_id = $2 AND listing_id = $3 AND source = 'bot' AND created_at > $4
     ORDER BY created_at DESC LIMIT 1`,
    [broker.agency_id, broker.id, listing.id, new Date(Date.now() - RECENT_MS).toISOString()]
  );
  if (!rows[0]) return null;
  await saveSession(pool, broker.id, { tokenHash: rows[0].token_hash, code: listing.code, rent: listing.listing_type === "rent", step: "choose" });
  return buttons(broker.preferred_lang);
}

/** The picker's buttons: lk:num | lk:id | lk:contact | lk:skip → the prompt to answer (or done). */
async function handleButton(pool, broker, id, { reply, lang }) {
  const en = lang === "en";
  const s = await pending(pool, broker);
  if (!s) return reply(broker, en ? "⏳ That link choice has expired. Tap Client Copy again." : "⏳ اختيار الرابط ده انتهى. اضغط نص العميل تاني.");
  if (id === "lk:skip") {
    await clearSession(pool, broker.id);
    return reply(broker, en ? `✅ Sent with no recipient (${s.code}).` : `✅ اتسجل من غير مستلم (${s.code}).`);
  }
  const step = id === "lk:num" ? "number" : id === "lk:id" ? "id" : "contact";
  await saveSession(pool, broker.id, { ...s, step });
  if (step === "number") return reply(broker, en ? "📱 Send the client's mobile number (01xxxxxxxxx), or type *skip*." : "📱 ابعت رقم العميل (01xxxxxxxxx)، أو اكتب *تخطي*.");
  if (step === "id") return reply(broker, en ? "🆔 Send the lead ID (for example L-0042), or type *skip*." : "🆔 ابعت رقم العميل في النظام (مثلاً L-0042)، أو اكتب *تخطي*.");
  return reply(broker, en ? "📇 Share a contact from Telegram (📎 → Contact), or type *skip*." : "📇 ابعت جهة اتصال من تيليجرام (📎 ← جهة اتصال)، أو اكتب *تخطي*.");
}

/**
 * The broker's next text or contact while a choice is waiting. Returns false when nothing is waiting (or the text is not an
 * answer yet), so the message goes on to the usual handlers.
 */
async function handleInput(pool, broker, message, { reply, lang, replyClient }) {
  const en = lang === "en";
  const s = await pending(pool, broker);
  if (!s) return false;
  if (message.type === "text") {
    const text = String(message.text?.body || "").trim();
    // In the name step, skip means "the number is the name"; everywhere else skip ends the choice.
    if (s.step === "name") return finishName(pool, broker, s, text, { reply, lang, replyClient });
    if (/^(?:تخطي|skip)$/i.test(text)) {
      await clearSession(pool, broker.id);
      await reply(broker, en ? `✅ Sent with no recipient (${s.code}).` : `✅ اتسجل من غير مستلم (${s.code}).`);
      return true;
    }
    if (s.step === "choose" || !s.step) return false;
    return attach(pool, broker, s, { text }, { reply, lang, replyClient });
  }
  if (message.type === "contacts") {
    const c = message.contacts?.[0];
    const phone = c?.phones?.[0]?.phone;
    if (!phone) return false;
    const digits = Phone.normalizePhone(phone);
    const name = [c?.name?.first_name, c?.name?.last_name].filter(Boolean).join(" ") || c?.name?.formatted_name || null;
    return attach(pool, broker, s, { text: digits ? `+${digits}` : String(phone), name }, { reply, lang, replyClient });
  }
  return false;
}

/** A number that is not a lead yet: the name the broker types (skip = the number itself), then the lead is created. */
async function finishName(pool, broker, s, text, { reply, lang, replyClient }) {
  const name = /^(?:تخطي|skip)$/i.test(text) || !text ? null : text.slice(0, 80);
  return attach(pool, broker, { ...s, step: "choose" }, { text: `+${s.phone}`, name: name || `+${s.phone}` }, { reply, lang, replyClient });
}

async function attach(pool, broker, s, { text, name = undefined }, { reply, lang, replyClient }) {
  const en = lang === "en";
  const r = await Recipients.resolveRecipient(pool, broker, text);
  if (r.error) {
    await reply(broker, r.error === "lead_not_found" ? (en ? "No lead with that ID. Send another, or type *skip*." : "مفيش عميل بالرقم ده. ابعت رقم تاني، أو اكتب *تخطي*.") : en ? "That isn't a valid mobile number. Send it again, or type *skip*." : "الرقم مش صحيح. ابعته تاني، أو اكتب *تخطي*.");
    return true;
  }
  let leadId = r.leadId;
  // A number that is no lead yet: ask its name first (a shared contact already has one), then add it as a lead.
  if (!leadId && r.phone && name === undefined) {
    await saveSession(pool, broker.id, { ...s, step: "name", phone: r.phone });
    await reply(broker, en ? "👤 The client's name? Type it, or *skip* (the number becomes the name)." : "👤 اسم العميل؟ اكتبه، أو *تخطي* (الرقم يبقى الاسم).");
    return true;
  }
  if (!leadId && r.phone) {
    const out = await Leads.captureLead(pool, broker, { phones: `+${r.phone}`, name: name || `+${r.phone}`, kind: s.rent ? "tenant" : "buyer" }, { quiet: true });
    if (out.outcome === "erased_before") {
      await clearSession(pool, broker.id);
      await reply(broker, en ? "This client asked not to be contacted, so the link was not attached." : "العميل ده طلب مايتكلمش معاه، فالرابط ماتسجلش.");
      return true;
    }
    if (out.lead && (out.outcome === "created" || out.outcome === "merged")) leadId = out.lead.id;
  }
  await pool.query(
    "UPDATE share_links SET recipient_phone = $3, lead_id = $4 WHERE token_hash = $1 AND agency_id = $2 AND broker_id = $5",
    [s.tokenHash, broker.agency_id, r.phone, leadId, broker.id]
  );
  await clearSession(pool, broker.id);
  const wa = r.phone ? Phone.waMeUrl(r.phone) : null;
  const who = r.phone ? Phone.displayPhone(r.phone) : en ? "no number" : "من غير رقم";
  const body = en ? `✅ Linked to ${who} (${s.code}).` : `✅ اتربط بـ ${who} (${s.code}).`;
  // Telegram: a "📤 Send on WhatsApp" button opens the chat instead of a raw link.
  if (replyClient && wa) await replyClient(broker, body, { phone: r.phone, lang, url: wa });
  else await reply(broker, body);
  return true;
}

module.exports = { SESSION, TTL_MIN, buttons, offer, pending, handleButton, handleInput, attach };
